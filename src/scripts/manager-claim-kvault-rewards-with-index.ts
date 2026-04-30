import "dotenv/config";
import * as fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { Farms } from "@kamino-finance/farms-sdk";
import {
  DEFAULT_KLEND_PROGRAM_ID,
  KaminoVault,
  KVAULTS_PROGRAM_ID,
} from "@kamino-finance/klend-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  address,
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  getAddressEncoder,
  getProgramDerivedAddress,
  type SolanaRpcApi,
} from "@solana/kit";
import { AccountMeta, Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  findVaultStrategyAuthPda,
  getWithdrawStrategyInstructionAsync,
} from "@voltr/vault-sdk";
import Decimal from "decimal.js";
import {
  createKitSignerFromKeypair,
  getAddressLookupTableAccounts,
  kitInstructionToWeb3,
  publicKeyToAddress,
  sendAndConfirmOptimisedTx,
} from "../utils/helper";
import { getVaultReserves } from "../utils/kamino";
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  vaultAddress,
} from "../../config/base";
import { kvaultAddress, kvaultRewardIndex } from "../../config/kamino";
import {
  ADAPTOR_PROGRAM_ID,
  DISCRIMINATOR,
  FARM_GLOBAL_CONFIG,
  SCOPE,
} from "../constants/kamino";
import { setupJupiterSwap } from "../utils/jupiter";

const claimVaultRewardsWithIndex = async (
  connection: Connection,
  managerKp: Keypair,
  vault: PublicKey,
  vaultAssetMint: PublicKey,
  assetTokenProgramPk: PublicKey,
  adaptorProgram: PublicKey,
  farmGlobalConfig: PublicKey,
  kvault: PublicKey,
  klendProgram: PublicKey,
  kvaultsProgram: PublicKey,
  sharesTokenProgram: PublicKey,
  scope: PublicKey,
  instructionDiscriminator: number[],
  rewardIndex: number,
  lookupTableAddresses: string[] = []
) => {
  const managerSigner = await createKitSignerFromKeypair(managerKp);
  const addressEncoder = getAddressEncoder();
  const [vaultStrategyAuth] = await findVaultStrategyAuthPda({
    vault: publicKeyToAddress(vault),
    strategy: publicKeyToAddress(kvault),
  });

  const rpc = createRpc({
    api: createSolanaRpcApi<SolanaRpcApi>({
      ...DEFAULT_RPC_CONFIG,
      defaultCommitment: "processed",
    }),
    transport: createDefaultRpcTransport({ url: process.env.HELIUS_RPC_URL! }),
  });
  const kaminoVault = new KaminoVault(address(kvault.toBase58()));
  const vaultState = await kaminoVault.getState(rpc as any);
  const { vaultReservesAccountMetas, vaultReservesLendingMarkets } =
    await getVaultReserves(rpc as any, vaultState);
  const farms = new Farms(rpc as never);

  const timestamp = new Date().getUTCMilliseconds() / 1000;
  const farmsForUser = await farms.getAllFarmsForUser(
    address(vaultStrategyAuth),
    new Decimal(timestamp)
  );

  const vaultStrategyAuthPk = new PublicKey(vaultStrategyAuth);
  const [sharesMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("shares"), kvault.toBuffer()],
    kvaultsProgram
  );
  const userSharesAta = getAssociatedTokenAddressSync(
    sharesMint,
    vaultStrategyAuthPk,
    true,
    sharesTokenProgram
  );

  for (const [, farmData] of Array.from(farmsForUser.entries())) {
    if (rewardIndex >= farmData.pendingRewards.length) {
      console.log("Reward index", rewardIndex, "out of range for farm", farmData.farm);
      continue;
    }

    const userState = farmData.userStateAddress;
    const farmState = farmData.farm;
    const rewardMint = farmData.pendingRewards[rewardIndex].rewardTokenMint;
    const rewardTokenProgramId =
      farmData.pendingRewards[rewardIndex].rewardTokenProgramId;
    const rewardAmount =
      farmData.pendingRewards[rewardIndex].cumulatedPendingRewards;

    if (rewardAmount.lte(0)) {
      console.log("No rewards to claim for farm", farmState, "at index", rewardIndex);
      continue;
    }

    const userRewardAta = getAssociatedTokenAddressSync(
      new PublicKey(rewardMint),
      vaultStrategyAuthPk,
      true,
      new PublicKey(rewardTokenProgramId)
    );

    const [rewardsVault] = await getProgramDerivedAddress({
      seeds: [
        Buffer.from("rvault"),
        addressEncoder.encode(farmState),
        addressEncoder.encode(rewardMint),
      ],
      programAddress: farms.getProgramID(),
    });
    const [farmVaultsAuthority] = await getProgramDerivedAddress({
      seeds: [Buffer.from("authority"), addressEncoder.encode(farmState)],
      programAddress: farms.getProgramID(),
    });
    const [rewardsTreasuryVault] = await getProgramDerivedAddress({
      seeds: [
        Buffer.from("tvault"),
        farmGlobalConfig.toBuffer(),
        addressEncoder.encode(rewardMint),
      ],
      programAddress: farms.getProgramID(),
    });

    const createUserRewardAtaIdempotent =
      createAssociatedTokenAccountIdempotentInstruction(
        managerKp.publicKey,
        userRewardAta,
        vaultStrategyAuthPk,
        new PublicKey(rewardMint),
        new PublicKey(rewardTokenProgramId)
      );

    const claimRewardsRemainingAccounts: AccountMeta[] = [
      { pubkey: kvault, isSigner: false, isWritable: true },
      { pubkey: userSharesAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(userState), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(farmState), isSigner: false, isWritable: true },
      { pubkey: farmGlobalConfig, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(rewardMint), isSigner: false, isWritable: false },
      { pubkey: userRewardAta, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(rewardsVault), isSigner: false, isWritable: true },
      {
        pubkey: new PublicKey(rewardsTreasuryVault),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: new PublicKey(farmVaultsAuthority),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: scope, isSigner: false, isWritable: false },
      {
        pubkey: new PublicKey(rewardTokenProgramId),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: new PublicKey(farms.getProgramID()),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: klendProgram, isSigner: false, isWritable: false },
    ];

    const {
      jupiterSwapAddressLookupTableAccounts,
      jupiterSwapData,
      jupiterSwapAccountMetas,
    } = await setupJupiterSwap(
      connection,
      new BN(rewardAmount.toString()),
      vaultStrategyAuthPk,
      new PublicKey(rewardMint),
      new PublicKey(assetMintAddress)
    );

    const rewardIndexBuf = Buffer.alloc(8);
    rewardIndexBuf.writeBigUInt64LE(BigInt(rewardIndex));
    const additionalArgs = Buffer.concat([rewardIndexBuf, jupiterSwapData]);

    const withdrawStrategyIx = kitInstructionToWeb3(
      await getWithdrawStrategyInstructionAsync({
        manager: managerSigner,
        vault: publicKeyToAddress(vault),
        strategy: publicKeyToAddress(kvault),
        vaultAssetMint: publicKeyToAddress(vaultAssetMint),
        assetTokenProgram: publicKeyToAddress(assetTokenProgramPk),
        adaptorProgram: publicKeyToAddress(adaptorProgram),
        amount: 0n,
        instructionDiscriminator: new Uint8Array(instructionDiscriminator),
        additionalArgs: new Uint8Array(additionalArgs),
      })
    );
    withdrawStrategyIx.keys.push(
      ...[
        ...claimRewardsRemainingAccounts,
        ...vaultReservesAccountMetas,
        ...vaultReservesLendingMarkets,
        ...jupiterSwapAccountMetas,
      ]
    );

    const lookupTableAccounts = await getAddressLookupTableAccounts(
      [...lookupTableAddresses, vaultState.vaultLookupTable.toString()],
      connection
    );

    const txSig = await sendAndConfirmOptimisedTx(
      [createUserRewardAtaIdempotent, withdrawStrategyIx],
      process.env.HELIUS_RPC_URL!,
      managerKp,
      [],
      [...jupiterSwapAddressLookupTableAccounts, ...lookupTableAccounts]
    );
    console.log("KVault strategy claimed rewards with index", rewardIndex, "signature:", txSig);
  }
};

const main = async () => {
  const payerSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8"))
  );
  const payerKp = Keypair.fromSecretKey(payerSecret);

  await claimVaultRewardsWithIndex(
    new Connection(process.env.HELIUS_RPC_URL!),
    payerKp,
    new PublicKey(vaultAddress),
    new PublicKey(assetMintAddress),
    new PublicKey(assetTokenProgram),
    new PublicKey(ADAPTOR_PROGRAM_ID),
    new PublicKey(FARM_GLOBAL_CONFIG),
    new PublicKey(kvaultAddress),
    new PublicKey(DEFAULT_KLEND_PROGRAM_ID),
    new PublicKey(KVAULTS_PROGRAM_ID),
    TOKEN_PROGRAM_ID,
    new PublicKey(SCOPE),
    DISCRIMINATOR.CLAIM_VAULT_REWARDS_WITH_INDEX,
    kvaultRewardIndex,
    [lookupTableAddress]
  );
};

main();
