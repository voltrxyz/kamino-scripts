import "dotenv/config";
import * as fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { Farms } from "@kamino-finance/farms-sdk";
import {
  DEFAULT_KLEND_PROGRAM_ID,
  getSingleReserve,
} from "@kamino-finance/klend-sdk";
import {
  address,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createRpc,
  createSolanaRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  type Address,
  type Instruction,
  type SolanaRpcApi,
} from "@solana/kit";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  findVaultStrategyAuthPda,
  getInitializeStrategyInstructionAsync,
} from "@voltr/vault-sdk";
import {
  appendRemainingAccounts,
  getAddressesByLookupTable,
  publicKeyToAddress,
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
  setupTokenAccount,
} from "../utils/helper";
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  useLookupTable,
  vaultAddress,
} from "../../config/base";
import { reserveAddress } from "../../config/kamino";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR } from "../constants/kamino";

const main = async () => {
  const payerSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8"))
  );
  const payerSigner = await createKeyPairSignerFromBytes(payerSecret);
  const sendRpc = createSolanaRpc(process.env.HELIUS_RPC_URL!);
  const kaminoRpc = createRpc({
    api: createSolanaRpcApi<SolanaRpcApi>({
      ...DEFAULT_RPC_CONFIG,
      defaultCommitment: "processed",
    }),
    transport: createDefaultRpcTransport({ url: process.env.HELIUS_RPC_URL! }),
  });

  const vaultAssetMintPk = new PublicKey(assetMintAddress);
  const reservePk = new PublicKey(reserveAddress);
  const klendProgramPk = new PublicKey(DEFAULT_KLEND_PROGRAM_ID);
  const strategy = publicKeyToAddress(reservePk);
  const [vaultStrategyAuth] = await findVaultStrategyAuthPda({
    vault: vaultAddress,
    strategy,
  });

  const transactionIxs: Instruction[] = [];

  await setupTokenAccount(
    sendRpc,
    payerSigner,
    assetMintAddress,
    vaultStrategyAuth,
    transactionIxs,
    assetTokenProgram
  );

  await setupTokenAccount(
    sendRpc,
    payerSigner,
    assetMintAddress,
    payerSigner.address,
    transactionIxs,
    assetTokenProgram
  );

  const farms = new Farms(kaminoRpc as any);
  const reserveAccount = await getSingleReserve(
    address(reservePk.toBase58()),
    kaminoRpc as any,
    400
  );
  const lendingMarket = new PublicKey(reserveAccount.state.lendingMarket.toString());
  const [obligation] = PublicKey.findProgramAddressSync(
    [
      new BN(0).toArrayLike(Buffer, "le", 1),
      new BN(0).toArrayLike(Buffer, "le", 1),
      new PublicKey(vaultStrategyAuth).toBuffer(),
      lendingMarket.toBuffer(),
      SystemProgram.programId.toBuffer(),
      SystemProgram.programId.toBuffer(),
    ],
    klendProgramPk
  );
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), lendingMarket.toBuffer()],
    klendProgramPk
  );
  const [reserveFarmState, obligationFarm] =
    reserveAccount.state.farmCollateral.toString() === PublicKey.default.toString()
      ? [new PublicKey(DEFAULT_KLEND_PROGRAM_ID), new PublicKey(DEFAULT_KLEND_PROGRAM_ID)]
      : [
          new PublicKey(reserveAccount.state.farmCollateral),
          PublicKey.findProgramAddressSync(
            [
              Buffer.from("user"),
              new PublicKey(reserveAccount.state.farmCollateral).toBuffer(),
              obligation.toBuffer(),
            ],
            new PublicKey(farms.getProgramID().toString())
          )[0],
        ];

  const [userMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_meta"), new PublicKey(vaultStrategyAuth).toBuffer()],
    klendProgramPk
  );

  const remainingAccounts = [
    { pubkey: userMetadata, isSigner: false, isWritable: true },
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
    { pubkey: reservePk, isSigner: false, isWritable: true },
    { pubkey: reserveFarmState, isSigner: false, isWritable: true },
    { pubkey: obligationFarm, isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    {
      pubkey: new PublicKey(farms.getProgramID().toString()),
      isSigner: false,
      isWritable: false,
    },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: klendProgramPk, isSigner: false, isWritable: false },
  ];

  const initializeStrategyIx = await getInitializeStrategyInstructionAsync({
    payer: payerSigner,
    manager: payerSigner,
    vault: vaultAddress,
    strategy,
    adaptorProgram: address(ADAPTOR_PROGRAM_ID),
    instructionDiscriminator: new Uint8Array(DISCRIMINATOR.INITIALIZE_MARKET),
    additionalArgs: null,
  });

  transactionIxs.push(
    appendRemainingAccounts(initializeStrategyIx, remainingAccounts)
  );

  const lookupTables =
    useLookupTable && lookupTableAddress
      ? await getAddressesByLookupTable([lookupTableAddress], sendRpc)
      : {};

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    payerSigner,
    lookupTables
  );
  console.log("Market strategy initialized with signature:", txSig);

  if (useLookupTable && lookupTableAddress) {
    const lutIxs: Instruction[] = [];
    const ixAddresses: Address[] = Array.from(
      new Set(
        (transactionIxs[transactionIxs.length - 1].accounts ?? []).map(
          (account) => account.address as Address
        )
      )
    );

    await setupAddressLookupTable(
      sendRpc,
      payerSigner,
      payerSigner,
      ixAddresses,
      lutIxs,
      lookupTableAddress
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      lutIxs,
      process.env.HELIUS_RPC_URL!,
      payerSigner,
      undefined,
      50_000
    );

    console.log(`LUT updated with signature: ${txSig1}`);
  }
};

main();
