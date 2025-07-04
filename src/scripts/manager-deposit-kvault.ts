import "dotenv/config";
import * as fs from "fs";
import {
  Connection,
  Keypair,
  PublicKey,
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
import { depositStrategyAmount, kvaultAddress } from "../../config/kamino";
import { ADAPTOR_PROGRAM_ID, DISCRIMINATOR } from "../constants/kamino";
import {
  DEFAULT_KLEND_PROGRAM_ID,
  KaminoVault,
  KVAULTS_PROGRAM_ID,
} from "@kamino-finance/klend-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  address,
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  SolanaRpcApi,
} from "@solana/kit";
import { getVaultReserves } from "../utils/kamino";

const depositKVaultStrategy = async (
  connection: Connection,
  managerKp: Keypair,
  vault: PublicKey,
  vaultAssetMint: PublicKey,
  assetTokenProgram: PublicKey,
  adaptorProgram: PublicKey,
  kvault: PublicKey,
  klendProgram: PublicKey,
  kvaultsProgram: PublicKey,
  sharesTokenProgram: PublicKey,
  instructionDiscriminator: number[],
  depositAmount: BN,
  lookupTableAddresses: string[] = []
) => {
  const vc = new VoltrClient(connection);

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, kvault);

  let transactionIxs: TransactionInstruction[] = [];

  const _vaultStrategyAssetAta = await setupTokenAccount(
    connection,
    managerKp.publicKey,
    vaultAssetMint,
    vaultStrategyAuth,
    transactionIxs,
    assetTokenProgram
  );

  const managerAssetAta = await setupTokenAccount(
    connection,
    managerKp.publicKey,
    vaultAssetMint,
    managerKp.publicKey,
    transactionIxs,
    assetTokenProgram
  );

  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), kvault.toBuffer()],
    kvaultsProgram
  );

  const vaultStrategySharesAta = await setupTokenAccount(
    connection,
    managerKp.publicKey,
    sharesMint,
    vaultStrategyAuth,
    transactionIxs,
    sharesTokenProgram
  );

  const [tokenVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), kvault.toBuffer()],
    kvaultsProgram
  );

  const [baseVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority"), kvault.toBuffer()],
    kvaultsProgram
  );

  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    kvaultsProgram
  );

  const api = createSolanaRpcApi<SolanaRpcApi>({
    ...DEFAULT_RPC_CONFIG,
    defaultCommitment: "processed",
  });
  const rpc = createRpc({
    api,
    transport: createDefaultRpcTransport({ url: process.env.HELIUS_RPC_URL! }),
  });
  const kaminoVault = new KaminoVault(address(kvault.toBase58()));
  const vaultState = await kaminoVault.getState(rpc);

  const { vaultReservesAccountMetas, vaultReservesLendingMarkets } =
    await getVaultReserves(rpc, vaultState);

  // Prepare the remaining accounts
  const remainingAccounts = [
    { pubkey: kvault, isSigner: false, isWritable: true },
    { pubkey: tokenVault, isSigner: false, isWritable: true },
    { pubkey: baseVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: sharesMint, isSigner: false, isWritable: true },
    { pubkey: vaultStrategySharesAta, isSigner: false, isWritable: true },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: klendProgram, isSigner: false, isWritable: false },
    { pubkey: kvaultsProgram, isSigner: false, isWritable: false },
    { pubkey: sharesTokenProgram, isSigner: false, isWritable: false },
    ...vaultReservesAccountMetas,
    ...vaultReservesLendingMarkets,
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
      strategy: kvault,
      remainingAccounts,
      adaptorProgram,
    }
  );

  transactionIxs.push(createDepositStrategyIx);

  const lookupTableAccounts = await getAddressLookupTableAccounts(
    [...lookupTableAddresses, vaultState.vaultLookupTable.toString()],
    connection
  );

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    managerKp,
    [],
    lookupTableAccounts
  );
  console.log("KVault strategy deposited with signature:", txSig);
};

const main = async () => {
  const payerKpFile = fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8");
  const payerKpData = JSON.parse(payerKpFile);
  const payerSecret = Uint8Array.from(payerKpData);
  const payerKp = Keypair.fromSecretKey(payerSecret);

  await depositKVaultStrategy(
    new Connection(process.env.HELIUS_RPC_URL!),
    payerKp,
    new PublicKey(vaultAddress),
    new PublicKey(assetMintAddress),
    new PublicKey(assetTokenProgram),
    new PublicKey(ADAPTOR_PROGRAM_ID),
    new PublicKey(kvaultAddress),
    new PublicKey(DEFAULT_KLEND_PROGRAM_ID),
    new PublicKey(KVAULTS_PROGRAM_ID),
    TOKEN_PROGRAM_ID,
    DISCRIMINATOR.DEPOSIT_VAULT,
    new BN(depositStrategyAmount),
    [lookupTableAddress]
  );
};

main();
