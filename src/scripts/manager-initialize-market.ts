import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
  setupAddressLookupTable,
  setupTokenAccount,
} from "../utils/helper";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  assetMintAddress,
  vaultAddress,
  assetTokenProgram,
  useLookupTable,
  lookupTableAddress,
} from "../../config/base";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR } from "../constants/kamino";
import { reserveAddress } from "../../config/kamino";
import { DEFAULT_KLEND_PROGRAM_ID, getSingleReserve } from "@kamino-finance/klend-sdk";
import { address, createDefaultRpcTransport, createRpc, createSolanaRpcApi, DEFAULT_RPC_CONFIG, SolanaRpcApi, Address } from "@solana/kit";
import { Farms } from "@kamino-finance/farms-sdk";
import { BN } from "@coral-xyz/anchor";

const initializeMarketStrategy = async (
  connection: Connection,
  payerKp: Keypair,
  adminKp: Keypair,
  managerKp: Keypair,
  vault: PublicKey,
  vaultAssetMint: PublicKey,
  assetTokenProgram: PublicKey,
  adaptorProgram: PublicKey,
  reserve: PublicKey,
  klendProgram: PublicKey,
  instructionDiscriminator: number[],
  lookupTableAddresses: string[] = []
) => {
  const vc = new VoltrClient(connection);

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, reserve);

  let transactionIxs: TransactionInstruction[] = [];

  const _vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    managerKp.publicKey,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    assetTokenProgram
  );

  const _managerAssetAta = await setupTokenAccount(
    connection,
    managerKp.publicKey,
    vaultAssetMint,
    managerKp.publicKey,
    transactionIxs,
    assetTokenProgram
  );

  const api = createSolanaRpcApi<SolanaRpcApi>({
    ...DEFAULT_RPC_CONFIG,
    defaultCommitment: "processed",
  });
  const rpc = createRpc({
    api,
    transport: createDefaultRpcTransport({ url: process.env.HELIUS_RPC_URL! }),
  });
  const farms = new Farms(rpc);
  const reserveAccount = await getSingleReserve(address(reserve.toBase58()), rpc, 400);
  const lendingMarket = new PublicKey(reserveAccount.state.lendingMarket.toString());
  const [obligation] = PublicKey.findProgramAddressSync(
    [
      new BN(0).toArrayLike(Buffer, "le", 1),
      new BN(0).toArrayLike(Buffer, "le", 1),
      vaultStrategyAuth.toBuffer(),
      lendingMarket.toBuffer(),
      SystemProgram.programId.toBuffer(),
      SystemProgram.programId.toBuffer(),
    ],
    klendProgram
  );
  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), lendingMarket.toBuffer()],
    klendProgram
  );
  const [reserveFarmState, obligationFarm] =
    (reserveAccount.state.farmCollateral.toString() === PublicKey.default.toString()) ?
      [new PublicKey(DEFAULT_KLEND_PROGRAM_ID), new PublicKey(DEFAULT_KLEND_PROGRAM_ID)]
      :
      [new PublicKey(reserveAccount.state.farmCollateral), PublicKey.findProgramAddressSync(
        [Buffer.from("user"), new PublicKey(reserveAccount.state.farmCollateral).toBuffer(), obligation.toBuffer()],
        new PublicKey(farms.getProgramID().toString())
      )[0]]
    ;

  const [userMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_meta"), vaultStrategyAuth.toBuffer()],
    klendProgram
  );

  const remainingAccounts = [
    { pubkey: userMetadata, isSigner: false, isWritable: true },
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
    { pubkey: reserve, isSigner: false, isWritable: true },
    { pubkey: reserveFarmState, isSigner: false, isWritable: true },
    { pubkey: obligationFarm, isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(farms.getProgramID().toString()), isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: klendProgram, isSigner: false, isWritable: false },
  ];


  const createInitializeStrategyIx = await vc.createInitializeStrategyIx(
    {
      instructionDiscriminator: Buffer.from(instructionDiscriminator),
    },
    {
      payer: payerKp.publicKey,
      manager: managerKp.publicKey,
      vault,
      strategy: reserve,
      remainingAccounts,
      adaptorProgram,
    }
  );

  transactionIxs.push(createInitializeStrategyIx);

  const lookupTableAccounts = lookupTableAddresses
    ? await getAddressLookupTableAccounts(lookupTableAddresses, connection)
    : [];

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    managerKp,
    [],
    lookupTableAccounts
  );
  console.log("Market strategy initialized with signature:", txSig);

  if (useLookupTable) {
    const transactionIxs1: TransactionInstruction[] = [];

    const lut = await setupAddressLookupTable(
      connection,
      payerKp.publicKey,
      adminKp.publicKey,
      [
        ...new Set(
          transactionIxs.flatMap((ix) =>
            ix.keys.map((k) => k.pubkey.toBase58())
          )
        ),
      ],
      transactionIxs1,
      new PublicKey(lookupTableAddress)
    );

    const txSig1 = await sendAndConfirmOptimisedTx(
      transactionIxs1,
      process.env.HELIUS_RPC_URL!,
      payerKp,
      [adminKp],
      undefined,
      50_000
    );

    console.log(`LUT updated with signature: ${txSig1}`);
  }
};

const main = async () => {
  const payerKpFile = fs.readFileSync(process.env.ADMIN_FILE_PATH!, "utf-8");
  const payerKpData = JSON.parse(payerKpFile);
  const payerSecret = Uint8Array.from(payerKpData);
  const payerKp = Keypair.fromSecretKey(payerSecret);

  await initializeMarketStrategy(
    new Connection(process.env.HELIUS_RPC_URL!),
    payerKp,
    payerKp,
    payerKp,
    new PublicKey(vaultAddress),
    new PublicKey(assetMintAddress),
    new PublicKey(assetTokenProgram),
    new PublicKey(ADAPTOR_PROGRAM_ID),
    new PublicKey(reserveAddress),
    new PublicKey(DEFAULT_KLEND_PROGRAM_ID),
    DISCRIMINATOR.INITIALIZE_MARKET
  );
};

main();
