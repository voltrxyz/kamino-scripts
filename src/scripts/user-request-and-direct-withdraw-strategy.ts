import "dotenv/config";
import * as fs from "fs";
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
  findRequestWithdrawVaultReceiptPda,
  findVaultLpMintPda,
  findVaultStrategyAuthPda,
  getDirectWithdrawStrategyInstructionAsync,
  getRequestWithdrawVaultInstructionAsync,
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
  isWithdrawAll,
  isWithdrawInLp,
  lookupTableAddress,
  vaultAddress,
  withdrawAmountVault,
} from "../../config/base";
import { kvaultAddress } from "../../config/kamino";
import { ADAPTOR_PROGRAM_ID } from "../constants/kamino";

const main = async () => {
  const userSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.USER_FILE_PATH!, "utf-8"))
  );
  const userSigner = await createKeyPairSignerFromBytes(userSecret);
  const sendRpc = createSolanaRpc(process.env.HELIUS_RPC_URL!);
  const kaminoRpc = createRpc({
    api: createSolanaRpcApi<SolanaRpcApi>({
      ...DEFAULT_RPC_CONFIG,
      defaultCommitment: "processed",
    }),
    transport: createDefaultRpcTransport({ url: process.env.HELIUS_RPC_URL! }),
  });

  const transactionIxs: Instruction[] = [];
  const [vaultLpMint] = await findVaultLpMintPda({ vault: vaultAddress });
  const [requestWithdrawVaultReceipt] = await findRequestWithdrawVaultReceiptPda({
    vault: vaultAddress,
    userTransferAuthority: userSigner.address,
  });

  await setupTokenAccount(
    sendRpc,
    userSigner,
    vaultLpMint,
    requestWithdrawVaultReceipt,
    transactionIxs
  );

  const requestWithdrawVaultIx = await getRequestWithdrawVaultInstructionAsync({
    payer: userSigner,
    userTransferAuthority: userSigner,
    vault: vaultAddress,
    amount: withdrawAmountVault,
    isAmountInLp: isWithdrawInLp,
    isWithdrawAll,
  });
  transactionIxs.push(requestWithdrawVaultIx);

  const vaultAssetMintPk = new PublicKey(assetMintAddress);
  const kvaultPk = new PublicKey(kvaultAddress);
  const kvaultsProgramPk = new PublicKey(KVAULTS_PROGRAM_ID);
  const strategy = publicKeyToAddress(kvaultPk);
  const [vaultStrategyAuth] = await findVaultStrategyAuthPda({
    vault: vaultAddress,
    strategy,
  });

  await setupTokenAccount(
    sendRpc,
    userSigner,
    assetMintAddress,
    vaultStrategyAuth,
    transactionIxs,
    assetTokenProgram
  );

  await setupTokenAccount(
    sendRpc,
    userSigner,
    assetMintAddress,
    userSigner.address,
    transactionIxs,
    assetTokenProgram
  );

  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), kvaultPk.toBuffer()],
    kvaultsProgramPk
  );
  const vaultStrategySharesAta = await setupTokenAccount(
    sendRpc,
    userSigner,
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

  const directWithdrawStrategyIx =
    await getDirectWithdrawStrategyInstructionAsync({
      userTransferAuthority: userSigner,
      vault: vaultAddress,
      strategy,
      vaultAssetMint: assetMintAddress,
      adaptorProgram: address(ADAPTOR_PROGRAM_ID),
      assetTokenProgram,
      userArgs: null,
    });

  transactionIxs.push(
    appendRemainingAccounts(directWithdrawStrategyIx, remainingAccounts)
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
    userSigner,
    lookupTables
  );
  console.log(
    "KVault request and strategy directly withdrawn with signature:",
    txSig
  );
};

main();
