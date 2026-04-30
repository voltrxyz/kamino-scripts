import "dotenv/config";
import * as fs from "fs";
import { BN } from "@coral-xyz/anchor";
import {
  DEFAULT_KLEND_PROGRAM_ID,
  KaminoVault,
  KVAULTS_PROGRAM_ID,
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
import { PublicKey } from "@solana/web3.js";
import {
  findVaultStrategyAuthPda,
  getDepositStrategyInstructionAsync,
} from "@voltr/vault-sdk";
import {
  appendRemainingAccounts,
  getAddressesByLookupTable,
  publicKeyToAddress,
  sendAndConfirmOptimisedTx,
  setupTokenAccount,
} from "../utils/helper";
import { getVaultReserves } from "../utils/kamino";
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  vaultAddress,
} from "../../config/base";
import { depositStrategyAmount, kvaultAddress } from "../../config/kamino";
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

  const kvaultPk = new PublicKey(kvaultAddress);
  const kvaultsProgramPk = new PublicKey(KVAULTS_PROGRAM_ID);
  const strategy = publicKeyToAddress(kvaultPk);
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

  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), kvaultPk.toBuffer()],
    kvaultsProgramPk
  );

  const vaultStrategySharesAta = await setupTokenAccount(
    sendRpc,
    managerSigner,
    publicKeyToAddress(sharesMint),
    vaultStrategyAuth,
    transactionIxs,
    publicKeyToAddress(TOKEN_PROGRAM_ID)
  );

  const [tokenVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), kvaultPk.toBuffer()],
    kvaultsProgramPk
  );

  const [baseVaultAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("authority"), kvaultPk.toBuffer()],
    kvaultsProgramPk
  );

  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    kvaultsProgramPk
  );

  const kaminoVault = new KaminoVault(address(kvaultPk.toBase58()));
  const vaultState = await kaminoVault.getState(kaminoRpc as any);
  const { vaultReservesAccountMetas, vaultReservesLendingMarkets } =
    await getVaultReserves(kaminoRpc as any, vaultState);

  const remainingAccounts = [
    { pubkey: kvaultPk, isSigner: false, isWritable: true },
    { pubkey: tokenVault, isSigner: false, isWritable: true },
    { pubkey: baseVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: sharesMint, isSigner: false, isWritable: true },
    {
      pubkey: new PublicKey(vaultStrategySharesAta),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(DEFAULT_KLEND_PROGRAM_ID), isSigner: false, isWritable: false },
    { pubkey: kvaultsProgramPk, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ...vaultReservesAccountMetas,
    ...vaultReservesLendingMarkets,
  ];

  const depositStrategyIx = await getDepositStrategyInstructionAsync({
    manager: managerSigner,
    vault: vaultAddress,
    strategy,
    vaultAssetMint: assetMintAddress,
    assetTokenProgram,
    adaptorProgram: address(ADAPTOR_PROGRAM_ID),
    amount: BigInt(new BN(depositStrategyAmount).toString()),
    instructionDiscriminator: new Uint8Array(DISCRIMINATOR.DEPOSIT_VAULT),
    additionalArgs: null,
  });

  transactionIxs.push(
    appendRemainingAccounts(depositStrategyIx, remainingAccounts)
  );

  const lookupTables = await getAddressesByLookupTable(
    [lookupTableAddress, vaultState.vaultLookupTable.toString()].map((value) =>
      address(value)
    ),
    sendRpc
  );

  const txSig = await sendAndConfirmOptimisedTx(
    transactionIxs,
    process.env.HELIUS_RPC_URL!,
    managerSigner,
    lookupTables
  );
  console.log("KVault strategy deposited with signature:", txSig);
};

main();
