import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
  setupTokenAccount,
} from "../utils/helper";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  assetMintAddress,
  vaultAddress,
  assetTokenProgram,
  lookupTableAddress,
} from "../../config/base";
import { depositStrategyAmount, reserveAddress } from "../../config/kamino";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR } from "../constants/kamino";
import {
  DEFAULT_KLEND_PROGRAM_ID,
  getSingleReserve,
} from "@kamino-finance/klend-sdk";
import { Farms } from "@kamino-finance/farms-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  address,
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  SolanaRpcApi,
} from "@solana/kit";

const depositMarketStrategy = async (
  connection: Connection,
  managerKp: Keypair,
  vault: PublicKey,
  vaultAssetMint: PublicKey,
  assetTokenProgram: PublicKey,
  adaptorProgram: PublicKey,
  reserve: PublicKey,
  klendProgram: PublicKey,
  instructionDiscriminator: number[],
  depositAmount: BN,
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
  const reserveLiquiditySupply = new PublicKey(reserveAccount.state.liquidity.supplyVault.toString());
  const reserveCollateralMint = new PublicKey(reserveAccount.state.collateral.mintPubkey.toString());
  const reserveDestinationDepositCollateral = new PublicKey(reserveAccount.state.collateral.supplyVault.toString());
  const [reserveFarmState, obligationFarm] =
    (reserveAccount.state.farmCollateral.toString() === PublicKey.default.toString()) ?
      [new PublicKey(DEFAULT_KLEND_PROGRAM_ID), new PublicKey(DEFAULT_KLEND_PROGRAM_ID)]
      :
      [new PublicKey(reserveAccount.state.farmCollateral), PublicKey.findProgramAddressSync(
        [Buffer.from("user"), new PublicKey(reserveAccount.state.farmCollateral).toBuffer(), obligation.toBuffer()],
        new PublicKey(farms.getProgramID().toString())
      )[0]]
  
  const [userMetadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_meta"), vaultStrategyAuth.toBuffer()],
    klendProgram
  );
  const scope = new PublicKey(reserveAccount.state.config.tokenInfo.scopeConfiguration.priceFeed.toString());

  // Prepare the remaining accounts
  const remainingAccounts = [
    { pubkey: obligation, isSigner: false, isWritable: true },
    { pubkey: lendingMarket, isSigner: false, isWritable: false },
    { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
    { pubkey: reserve, isSigner: false, isWritable: true },
    { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
    { pubkey: reserveCollateralMint, isSigner: false, isWritable: true },
    { pubkey: reserveDestinationDepositCollateral, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: obligationFarm, isSigner: false, isWritable: true },
    { pubkey: reserveFarmState, isSigner: false, isWritable: true },
    { pubkey: userMetadata, isSigner: false, isWritable: true },
    { pubkey: scope, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(farms.getProgramID().toString()), isSigner: false, isWritable: false },
    { pubkey: klendProgram, isSigner: false, isWritable: false },
  ];

  const createDepositStrategyIx = await vc.createDepositStrategyIx(
    {
      instructionDiscriminator: Buffer.from(instructionDiscriminator),
      depositAmount,
    },
    {
      manager: managerKp.publicKey,
      vault,
      vaultAssetMint,
      assetTokenProgram,
      strategy: reserve,
      remainingAccounts,
      adaptorProgram,
    }
  );

  transactionIxs.push(createDepositStrategyIx);

  const lookupTableAccounts = await getAddressLookupTableAccounts(
    [...lookupTableAddresses],
    connection
  );

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    managerKp,
    [],
    lookupTableAccounts
  );
  console.log("Market strategy deposited with signature:", txSig);
};

const main = async () => {
  const payerKpFile = fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8");
  const payerKpData = JSON.parse(payerKpFile);
  const payerSecret = Uint8Array.from(payerKpData);
  const payerKp = Keypair.fromSecretKey(payerSecret);

  await depositMarketStrategy(
    new Connection(process.env.HELIUS_RPC_URL!),
    payerKp,
    new PublicKey(vaultAddress),
    new PublicKey(assetMintAddress),
    new PublicKey(assetTokenProgram),
    new PublicKey(ADAPTOR_PROGRAM_ID),
    new PublicKey(reserveAddress),
    new PublicKey(DEFAULT_KLEND_PROGRAM_ID),
    DISCRIMINATOR.DEPOSIT_MARKET,
    new BN(depositStrategyAmount),
    [lookupTableAddress]
  );
};

main();
