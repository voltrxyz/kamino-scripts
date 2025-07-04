import {
  getMedianSlotDurationInMsFromLastEpochs,
  getTokenOracleData,
  KaminoReserve,
  parseTokenSymbol,
  Reserve,
  VaultState,
} from "@kamino-finance/klend-sdk";
import { address, Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const getVaultReserves = async (
  rpc: Rpc<SolanaRpcApi>,
  vaultState: VaultState
) => {
  const vaultAllocations = vaultState.vaultAllocationStrategy.filter(
    (vaultAllocation) =>
      !new PublicKey(vaultAllocation.reserve).equals(PublicKey.default)
  );

  const vaultReserves = vaultAllocations.map(
    (allocation) => allocation.reserve
  );

  const reserveAccounts = await rpc
    .getMultipleAccounts(vaultReserves, {
      commitment: "processed",
    })
    .send();

  const deserializedReserves = reserveAccounts.value.map((reserve, i) => {
    if (reserve === null) {
      // maybe reuse old here
      throw new Error(`Reserve account ${vaultReserves[i]} was not found`);
    }
    const reserveAccount = Reserve.decode(
      Buffer.from(reserve.data[0], "base64")
    );
    if (!reserveAccount) {
      throw Error(`Could not parse reserve ${vaultReserves[i]}`);
    }
    return reserveAccount;
  });

  const reservesAndOracles = await getTokenOracleData(
    rpc,
    deserializedReserves
  );

  const kaminoReserves = new Map<Address, KaminoReserve>();
  const slotDuration = await getMedianSlotDurationInMsFromLastEpochs();

  reservesAndOracles.forEach(([reserve, oracle], index) => {
    if (!oracle) {
      throw Error(
        `Could not find oracle for ${parseTokenSymbol(
          reserve.config.tokenInfo.name
        )} reserve`
      );
    }
    const kaminoReserve = KaminoReserve.initialize(
      vaultReserves[index],
      reserve,
      oracle,
      rpc,
      slotDuration
    );
    kaminoReserves.set(kaminoReserve.address, kaminoReserve);
  });

  let vaultReservesAccountMetas: AccountMeta[] = [];
  let vaultReservesLendingMarkets: AccountMeta[] = [];
  vaultReserves.forEach((reserve) => {
    const reserveState = kaminoReserves.get(reserve);
    if (reserveState === undefined) {
      throw new Error(`Reserve ${reserve.toString()} not found`);
    }
    vaultReservesAccountMetas = vaultReservesAccountMetas.concat([
      { pubkey: new PublicKey(reserve), isSigner: false, isWritable: true },
    ]);
    vaultReservesLendingMarkets = vaultReservesLendingMarkets.concat([
      {
        pubkey: new PublicKey(reserveState.state.lendingMarket),
        isSigner: false,
        isWritable: false,
      },
    ]);
  });

  let maxAllocatedReserve: Address = address(PublicKey.default.toString());
  let maxAllocated: BN = new BN(0);

  vaultAllocations.forEach((allocation) => {
    if (allocation.targetAllocationWeight.gt(maxAllocated)) {
      maxAllocated = allocation.targetAllocationWeight;
      maxAllocatedReserve = allocation.reserve;
    }
  });

  const maxAllocatedLendingMarket =
    kaminoReserves.get(maxAllocatedReserve)?.state.lendingMarket;
  if (!maxAllocatedLendingMarket) {
    throw new Error(`Reserve ${maxAllocatedReserve} not found`);
  }

  return {
    vaultReservesAccountMetas,
    vaultReservesLendingMarkets,
    maxAllocatedReserve: {
      reserve: new PublicKey(maxAllocatedReserve),
      lendingMarket: new PublicKey(maxAllocatedLendingMarket),
    },
  };
};
