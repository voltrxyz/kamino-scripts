import "dotenv/config";
import * as fs from "fs";
import { AccountMeta, Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAddressLookupTableAccounts,
  sendAndConfirmOptimisedTx,
} from "../utils/helper";
import { BN } from "@coral-xyz/anchor";
import { VoltrClient } from "@voltr/vault-sdk";
import {
  assetMintAddress,
  vaultAddress,
  assetTokenProgram,
  lookupTableAddress,
} from "../../config/base";
import { reserveAddress } from "../../config/kamino";
import {
  ADAPTOR_PROGRAM_ID,
  DISCRIMINATOR,
  FARM_GLOBAL_CONFIG,
} from "../constants/kamino";
import {
  DEFAULT_KLEND_PROGRAM_ID,
  getSingleReserve,
} from "@kamino-finance/klend-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  address,
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  getAddressEncoder,
  getProgramDerivedAddress,
  SolanaRpcApi,
} from "@solana/kit";
import { Farms } from "@kamino-finance/farms-sdk";
import Decimal from "decimal.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { setupJupiterSwap } from "../utils/jupiter";

const claimMarketReward = async (
  connection: Connection,
  managerKp: Keypair,
  vault: PublicKey,
  vaultAssetMint: PublicKey,
  assetTokenProgram: PublicKey,
  adaptorProgram: PublicKey,
  farmGlobalConfig: PublicKey,
  reserve: PublicKey,
  klendProgram: PublicKey,
  instructionDiscriminator: number[],
  lookupTableAddresses: string[] = []
) => {
  const vc = new VoltrClient(connection);
  const addressEncoder = getAddressEncoder();

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(vault, reserve);

  const api = createSolanaRpcApi<SolanaRpcApi>({
    ...DEFAULT_RPC_CONFIG,
    defaultCommitment: "processed",
  });
  const rpc = createRpc({
    api,
    transport: createDefaultRpcTransport({ url: process.env.HELIUS_RPC_URL! }),
  });
  const farms = new Farms(rpc);

  const timestamp = new Date().getUTCMilliseconds() / 1000;
  const farmsForUser = await farms.getAllFarmsForUser(
    address(vaultStrategyAuth.toBase58()),
    new Decimal(timestamp)
  );

  const farmsForUserArray = Array.from(farmsForUser.entries());

  for (const [_, farmData] of farmsForUserArray) {
    const userState = farmData.userStateAddress;
    const farmState = farmData.farm;
    const rewardMint = farmData.pendingRewards[0].rewardTokenMint;
    const userRewardAta = getAssociatedTokenAddressSync(
      new PublicKey(rewardMint),
      vaultStrategyAuth,
      true,
      new PublicKey(farmData.pendingRewards[0].rewardTokenProgramId)
    );
    const rewardAmount = farmData.pendingRewards[0].cumulatedPendingRewards;

    if (rewardAmount.lte(0)) {
      console.log("No rewards to claim for farm", farmState);
      continue;
    }

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

    const createUserRewardAtaIdemptotent =
      createAssociatedTokenAccountIdempotentInstruction(
        managerKp.publicKey,
        userRewardAta,
        vaultStrategyAuth,
        new PublicKey(rewardMint),
        new PublicKey(farmData.pendingRewards[0].rewardTokenProgramId)
      );
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
    const scope = new PublicKey(reserveAccount.state.config.tokenInfo.scopeConfiguration.priceFeed.toString());
    const claimRewardsRemainingAccounts: AccountMeta[] = [
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: lendingMarket, isSigner: false, isWritable: true },
      { pubkey: reserve, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(userState), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(farmState), isSigner: false, isWritable: true },
      { pubkey: farmGlobalConfig, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(rewardMint), isSigner: false, isWritable: false },
      { pubkey: userRewardAta, isSigner: false, isWritable: true },
      {
        pubkey: new PublicKey(rewardsVault),
        isSigner: false,
        isWritable: true,
      },
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
      {
        pubkey: scope,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: new PublicKey(farmData.pendingRewards[0].rewardTokenProgramId),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: new PublicKey(farms.getProgramID()),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: klendProgram,
        isSigner: false,
        isWritable: false,
      },
    ];

    const {
      jupiterSwapAddressLookupTableAccounts,
      jupiterSwapData,
      jupiterSwapAccountMetas,
    } = await setupJupiterSwap(
      connection,
      new BN(rewardAmount.toString()),
      vaultStrategyAuth,
      new PublicKey(rewardMint),
      new PublicKey(assetMintAddress)
    );

    const createWithdrawStrategyIx = await vc.createWithdrawStrategyIx(
      {
        instructionDiscriminator: Buffer.from(instructionDiscriminator),
        withdrawAmount: new BN(0),
        additionalArgs: jupiterSwapData,
      },
      {
        manager: managerKp.publicKey,
        vault,
        vaultAssetMint,
        assetTokenProgram,
        strategy: reserve,
        remainingAccounts: [
          ...claimRewardsRemainingAccounts,
          ...jupiterSwapAccountMetas,
        ],
        adaptorProgram,
      }
    );

    const lookupTableAccounts = await getAddressLookupTableAccounts(
      [...lookupTableAddresses],
      connection
    );

    const txSig = await sendAndConfirmOptimisedTx(
      [createUserRewardAtaIdemptotent, createWithdrawStrategyIx],
      process.env.HELIUS_RPC_URL!,
      managerKp,
      [],
      [...jupiterSwapAddressLookupTableAccounts, ...lookupTableAccounts]
    );
    console.log("Claimed market reward with signature:", txSig);
  }
};

const main = async () => {
  const payerKpFile = fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8");
  const payerKpData = JSON.parse(payerKpFile);
  const payerSecret = Uint8Array.from(payerKpData);
  const payerKp = Keypair.fromSecretKey(payerSecret);

  await claimMarketReward(
    new Connection(process.env.HELIUS_RPC_URL!),
    payerKp,
    new PublicKey(vaultAddress),
    new PublicKey(assetMintAddress),
    new PublicKey(assetTokenProgram),
    new PublicKey(ADAPTOR_PROGRAM_ID),
    new PublicKey(FARM_GLOBAL_CONFIG),
    new PublicKey(reserveAddress),
    new PublicKey(DEFAULT_KLEND_PROGRAM_ID),
    DISCRIMINATOR.CLAIM_MARKET_REWARD,
    [lookupTableAddress]
  );
};

main();
