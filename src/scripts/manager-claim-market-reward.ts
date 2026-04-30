import "dotenv/config";
import * as fs from "fs";
import { BN } from "@coral-xyz/anchor";
import { Farms } from "@kamino-finance/farms-sdk";
import {
  DEFAULT_KLEND_PROGRAM_ID,
  getSingleReserve,
} from "@kamino-finance/klend-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
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
import { AccountMeta, Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
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
import {
  assetMintAddress,
  assetTokenProgram,
  lookupTableAddress,
  vaultAddress,
} from "../../config/base";
import { reserveAddress } from "../../config/kamino";
import {
  ADAPTOR_PROGRAM_ID,
  DISCRIMINATOR,
  FARM_GLOBAL_CONFIG,
} from "../constants/kamino";
import { setupJupiterSwap } from "../utils/jupiter";

const claimMarketReward = async (
  connection: Connection,
  managerKp: Keypair,
  vault: PublicKey,
  vaultAssetMint: PublicKey,
  assetTokenProgramPk: PublicKey,
  adaptorProgram: PublicKey,
  farmGlobalConfig: PublicKey,
  reserve: PublicKey,
  klendProgram: PublicKey,
  instructionDiscriminator: number[],
  lookupTableAddresses: string[] = []
) => {
  const managerSigner = await createKitSignerFromKeypair(managerKp);
  const addressEncoder = getAddressEncoder();
  const [vaultStrategyAuth] = await findVaultStrategyAuthPda({
    vault: publicKeyToAddress(vault),
    strategy: publicKeyToAddress(reserve),
  });

  const rpc = createRpc({
    api: createSolanaRpcApi<SolanaRpcApi>({
      ...DEFAULT_RPC_CONFIG,
      defaultCommitment: "processed",
    }),
    transport: createDefaultRpcTransport({ url: process.env.HELIUS_RPC_URL! }),
  });
  const farms = new Farms(rpc as never);

  const timestamp = new Date().getUTCMilliseconds() / 1000;
  const farmsForUser = await farms.getAllFarmsForUser(
    address(vaultStrategyAuth),
    new Decimal(timestamp)
  );

  for (const [, farmData] of Array.from(farmsForUser.entries())) {
    const userState = farmData.userStateAddress;
    const farmState = farmData.farm;
    const rewardMint = farmData.pendingRewards[0].rewardTokenMint;
    const rewardTokenProgramId = farmData.pendingRewards[0].rewardTokenProgramId;
    const rewardAmount = farmData.pendingRewards[0].cumulatedPendingRewards;

    if (rewardAmount.lte(0)) {
      console.log("No rewards to claim for farm", farmState);
      continue;
    }

    const vaultStrategyAuthPk = new PublicKey(vaultStrategyAuth);
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

    const reserveAccount = await getSingleReserve(address(reserve.toBase58()), rpc as any, 400);
    const lendingMarket = new PublicKey(reserveAccount.state.lendingMarket.toString());
    const [obligation] = PublicKey.findProgramAddressSync(
      [
        new BN(0).toArrayLike(Buffer, "le", 1),
        new BN(0).toArrayLike(Buffer, "le", 1),
        vaultStrategyAuthPk.toBuffer(),
        lendingMarket.toBuffer(),
        SystemProgram.programId.toBuffer(),
        SystemProgram.programId.toBuffer(),
      ],
      klendProgram
    );
    const scope = new PublicKey(
      reserveAccount.state.config.tokenInfo.scopeConfiguration.priceFeed.toString()
    );
    const claimRewardsRemainingAccounts: AccountMeta[] = [
      { pubkey: obligation, isSigner: false, isWritable: true },
      { pubkey: lendingMarket, isSigner: false, isWritable: true },
      { pubkey: reserve, isSigner: false, isWritable: true },
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

    const withdrawStrategyIx = kitInstructionToWeb3(
      await getWithdrawStrategyInstructionAsync({
        manager: managerSigner,
        vault: publicKeyToAddress(vault),
        strategy: publicKeyToAddress(reserve),
        vaultAssetMint: publicKeyToAddress(vaultAssetMint),
        assetTokenProgram: publicKeyToAddress(assetTokenProgramPk),
        adaptorProgram: publicKeyToAddress(adaptorProgram),
        amount: 0n,
        instructionDiscriminator: new Uint8Array(instructionDiscriminator),
        additionalArgs: new Uint8Array(jupiterSwapData),
      })
    );
    withdrawStrategyIx.keys.push(
      ...[...claimRewardsRemainingAccounts, ...jupiterSwapAccountMetas]
    );

    const lookupTableAccounts = await getAddressLookupTableAccounts(
      [...lookupTableAddresses],
      connection
    );

    const txSig = await sendAndConfirmOptimisedTx(
      [createUserRewardAtaIdempotent, withdrawStrategyIx],
      process.env.HELIUS_RPC_URL!,
      managerKp,
      [],
      [...jupiterSwapAddressLookupTableAccounts, ...lookupTableAccounts]
    );
    console.log("Claimed market reward with signature:", txSig);
  }
};

const main = async () => {
  const payerSecret = Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.MANAGER_FILE_PATH!, "utf-8"))
  );
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
