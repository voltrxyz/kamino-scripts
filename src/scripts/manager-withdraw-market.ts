import "dotenv/config";
import * as fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { Farms } from "@kamino-finance/farms-sdk";
import {
  DEFAULT_KLEND_PROGRAM_ID,
  getSingleReserve,
} from "@kamino-finance/klend-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  address,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createRpc,
  createSolanaRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  type SolanaRpcApi,
  type Instruction,
} from "@solana/kit";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  findVaultStrategyAuthPda,
  getWithdrawStrategyInstructionAsync,
} from "@voltr/vault-sdk";
import {
  appendRemainingAccounts,
  getAddressesByLookupTable,
  publicKeyToAddress,
  sendAndConfirmOptimisedTx,
  setupTokenAccount,
} from "../utils/helper";
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  vaultAddress,
} from "../../config/base";
import { reserveAddress, withdrawStrategyAmount } from "../../config/kamino";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR } from "../constants/kamino";

const main = async () => {
  const managerSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8"))
  );
  const managerSigner = await createKeyPairSignerFromBytes(managerSecret);
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
    managerSigner,
    assetMintAddress,
    vaultStrategyAuth,
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
  const reserveLiquiditySupply = new PublicKey(
    reserveAccount.state.liquidity.supplyVault.toString()
  );
  const reserveCollateralMint = new PublicKey(
    reserveAccount.state.collateral.mintPubkey.toString()
  );
  const reserveSourceCollateral = new PublicKey(
    reserveAccount.state.collateral.supplyVault.toString()
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
  const scope = new PublicKey(
    reserveAccount.state.config.tokenInfo.scopeConfiguration.priceFeed.toString()
  );

  const remainingAccounts = [
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
    { pubkey: reservePk, isSigner: false, isWritable: true },
    { pubkey: reserveSourceCollateral, isSigner: false, isWritable: true },
    { pubkey: reserveCollateralMint, isSigner: false, isWritable: true },
    { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: obligationFarm, isSigner: false, isWritable: true },
    { pubkey: reserveFarmState, isSigner: false, isWritable: true },
    { pubkey: scope, isSigner: false, isWritable: false },
    {
      pubkey: new PublicKey(farms.getProgramID().toString()),
      isSigner: false,
      isWritable: false,
    },
    { pubkey: klendProgramPk, isSigner: false, isWritable: false },
  ];

  const withdrawStrategyIx = await getWithdrawStrategyInstructionAsync({
    manager: managerSigner,
    vault: vaultAddress,
    strategy,
    vaultAssetMint: assetMintAddress,
    assetTokenProgram,
    adaptorProgram: address(ADAPTOR_PROGRAM_ID),
    amount: BigInt(new BN(withdrawStrategyAmount).toString()),
    instructionDiscriminator: new Uint8Array(DISCRIMINATOR.WITHDRAW_MARKET),
    additionalArgs: null,
  });

  transactionIxs.push(
    appendRemainingAccounts(withdrawStrategyIx, remainingAccounts)
  );

  const lookupTables = await getAddressesByLookupTable(
    [lookupTableAddress].map((value) => address(value)),
    sendRpc
  );

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    managerSigner,
    lookupTables
  );
  console.log("Market strategy withdrawn with signature:", txSig);
};

main();
