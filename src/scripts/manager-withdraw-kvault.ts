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
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
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
import { getVaultReserves } from "../utils/kamino";
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  vaultAddress,
} from "../../config/base";
import { kvaultAddress, withdrawStrategyAmount } from "../../config/kamino";
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

  const [globalConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_config"), kvaultPk.toBuffer()],
    kvaultsProgramPk
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
  const {
    vaultReservesAccountMetas,
    vaultReservesLendingMarkets,
    maxAllocatedReserve,
  } = await getVaultReserves(kaminoRpc as any, vaultState);

  const [lendingMarketAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("lma"), maxAllocatedReserve.lendingMarket.toBuffer()],
    new PublicKey(DEFAULT_KLEND_PROGRAM_ID)
  );

  const [reserveLiquiditySupply] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("reserve_liq_supply"),
      maxAllocatedReserve.lendingMarket.toBuffer(),
      vaultAssetMintPk.toBuffer(),
    ],
    new PublicKey(DEFAULT_KLEND_PROGRAM_ID)
  );

  const [reserveCollateralMint] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("reserve_coll_mint"),
      maxAllocatedReserve.lendingMarket.toBuffer(),
      vaultAssetMintPk.toBuffer(),
    ],
    new PublicKey(DEFAULT_KLEND_PROGRAM_ID)
  );

  const [ctokenVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("ctoken_vault"),
      kvaultPk.toBuffer(),
      maxAllocatedReserve.reserve.toBuffer(),
    ],
    kvaultsProgramPk
  );

  const remainingAccounts = [
    { pubkey: kvaultPk, isSigner: false, isWritable: true },
    { pubkey: globalConfig, isSigner: false, isWritable: false },
    { pubkey: tokenVault, isSigner: false, isWritable: true },
    { pubkey: baseVaultAuthority, isSigner: false, isWritable: false },
    { pubkey: sharesMint, isSigner: false, isWritable: true },
    {
      pubkey: new PublicKey(vaultStrategySharesAta),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: maxAllocatedReserve.reserve, isSigner: false, isWritable: true },
    { pubkey: ctokenVault, isSigner: false, isWritable: true },
    {
      pubkey: maxAllocatedReserve.lendingMarket,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: lendingMarketAuthority, isSigner: false, isWritable: false },
    { pubkey: reserveLiquiditySupply, isSigner: false, isWritable: true },
    { pubkey: reserveCollateralMint, isSigner: false, isWritable: true },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: new PublicKey(DEFAULT_KLEND_PROGRAM_ID), isSigner: false, isWritable: false },
    { pubkey: kvaultsProgramPk, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ...vaultReservesAccountMetas,
    ...vaultReservesLendingMarkets,
  ];

  const withdrawStrategyIx = await getWithdrawStrategyInstructionAsync({
    manager: managerSigner,
    vault: vaultAddress,
    strategy,
    vaultAssetMint: assetMintAddress,
    assetTokenProgram,
    adaptorProgram: address(ADAPTOR_PROGRAM_ID),
    amount: BigInt(new BN(withdrawStrategyAmount).toString()),
    instructionDiscriminator: new Uint8Array(DISCRIMINATOR.WITHDRAW_VAULT),
    additionalArgs: null,
  });

  transactionIxs.push(
    appendRemainingAccounts(withdrawStrategyIx, remainingAccounts)
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
  console.log("KVault strategy withdrawn with signature:", txSig);
};

main();
