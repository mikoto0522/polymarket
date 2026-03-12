import { ClobClient, OrderType, Side as ClobSide, type TickSize } from '@polymarket/clob-client';
import { Contract, Wallet, ethers } from 'ethers';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_MAINNET = 137;
const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_DECIMALS = 6;

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function payoutNumerators(bytes32 conditionId, uint256 outcomeIndex) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function balanceOf(address account, uint256 positionId) view returns (uint256)',
];

export interface LiveTradingConfig {
  privateKey: string;
  rpcUrl?: string;
  chainId?: number;
}

export interface LiveOrderResult {
  success: boolean;
  errorMsg?: string;
  orderId?: string;
  transactionHashes?: string[];
}

export interface RedeemResult {
  success: boolean;
  txHash: string;
  usdcReceived: string;
  tokensRedeemed: string;
}

export class LiveTradingClient {
  private readonly wallet: Wallet;
  private readonly provider: ethers.providers.JsonRpcProvider;
  private readonly ctfContract: Contract;
  private readonly chainId: number;
  private clobClient: ClobClient | null = null;
  private initialized = false;
  private tickSizeCache = new Map<string, TickSize>();
  private negRiskCache = new Map<string, boolean>();
  private collateralApproved = false;

  constructor(private readonly config: LiveTradingConfig) {
    this.chainId = config.chainId || POLYGON_MAINNET;
    const rpcUrl = config.rpcUrl || 'https://polygon-rpc.com';
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl, this.chainId);
    this.wallet = new Wallet(config.privateKey, this.provider);
    this.ctfContract = new Contract(CTF_CONTRACT, CTF_ABI, this.wallet);
  }

  getAddress(): string {
    return this.wallet.address;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const l1Client = new ClobClient(CLOB_HOST, this.chainId, this.wallet);
    const derived = await l1Client.deriveApiKey();
    const creds = derived.key ? derived : await l1Client.createApiKey();
    if (!creds.key) {
      throw new Error('Failed to derive/create Polymarket API key');
    }

    this.clobClient = new ClobClient(
      CLOB_HOST,
      this.chainId,
      this.wallet,
      {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
    );

    await this.ensureCollateralAllowance();
    this.initialized = true;
  }

  async createMarketBuy(tokenId: string, amount: number): Promise<LiveOrderResult> {
    await this.initialize();
    const client = this.getClient();

    try {
      const [tickSize, negRisk] = await Promise.all([
        this.getTickSize(tokenId),
        this.getNegRisk(tokenId),
      ]);

      const result = await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          side: ClobSide.BUY,
          amount,
        },
        { tickSize, negRisk },
        OrderType.FOK,
      );

      const success = result.success === true ||
        (result.success !== false &&
          ((result.orderID !== undefined && result.orderID !== '') ||
            (result.transactionsHashes !== undefined && result.transactionsHashes.length > 0)));

      return {
        success,
        errorMsg: success ? undefined : (result.errorMsg || 'market order rejected'),
        orderId: result.orderID,
        transactionHashes: result.transactionsHashes,
      };
    } catch (error) {
      return {
        success: false,
        errorMsg: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async redeemByTokenIds(
    conditionId: string,
    tokenIds: { yesTokenId: string; noTokenId: string },
    winningTokenId: string,
  ): Promise<RedeemResult> {
    await this.initialize();

    const resolution = await this.getResolution(conditionId);
    if (!resolution.isResolved) {
      throw new Error('Market is not resolved yet');
    }

    const winningIndexSet = winningTokenId === tokenIds.yesTokenId ? 1 : 2;
    const winningBalance = await this.ctfContract.balanceOf(this.wallet.address, winningTokenId);
    if (winningBalance.lte(0)) {
      throw new Error('No winning tokens to redeem');
    }

    const tx = await this.ctfContract.redeemPositions(
      USDC_CONTRACT,
      ethers.constants.HashZero,
      conditionId,
      [winningIndexSet],
      await this.getGasOptions(),
    );

    const receipt = await tx.wait();
    return {
      success: true,
      txHash: receipt.transactionHash,
      usdcReceived: ethers.utils.formatUnits(winningBalance, USDC_DECIMALS),
      tokensRedeemed: ethers.utils.formatUnits(winningBalance, USDC_DECIMALS),
    };
  }

  private async ensureCollateralAllowance(): Promise<void> {
    if (this.collateralApproved) return;
    const client = this.getClient();
    const current = await client.getBalanceAllowance({
      asset_type: 'COLLATERAL' as any,
    });
    const allowance = ethers.BigNumber.from(current.allowance || '0');
    if (allowance.gt(0)) {
      this.collateralApproved = true;
      return;
    }

    await client.updateBalanceAllowance({
      asset_type: 'COLLATERAL' as any,
    });
    this.collateralApproved = true;
  }

  private async getTickSize(tokenId: string): Promise<TickSize> {
    const cached = this.tickSizeCache.get(tokenId);
    if (cached) return cached;
    const value = await this.getClient().getTickSize(tokenId);
    this.tickSizeCache.set(tokenId, value);
    return value;
  }

  private async getNegRisk(tokenId: string): Promise<boolean> {
    const cached = this.negRiskCache.get(tokenId);
    if (cached != null) return cached;
    const value = await this.getClient().getNegRisk(tokenId);
    this.negRiskCache.set(tokenId, value);
    return value;
  }

  private async getResolution(conditionId: string): Promise<{ isResolved: boolean }> {
    const [first, second, denom] = await Promise.all([
      this.ctfContract.payoutNumerators(conditionId, 0),
      this.ctfContract.payoutNumerators(conditionId, 1),
      this.ctfContract.payoutDenominator(conditionId),
    ]);
    return {
      isResolved: denom.gt(0) && (first.gt(0) || second.gt(0)),
    };
  }

  private async getGasOptions(): Promise<{
    maxPriorityFeePerGas: ethers.BigNumber;
    maxFeePerGas: ethers.BigNumber;
  }> {
    const feeData = await this.provider.getFeeData();
    const baseFee = feeData.lastBaseFeePerGas || feeData.gasPrice || ethers.utils.parseUnits('100', 'gwei');
    const priority = feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(ethers.utils.parseUnits('30', 'gwei'))
      ? feeData.maxPriorityFeePerGas
      : ethers.utils.parseUnits('30', 'gwei');
    return {
      maxPriorityFeePerGas: priority,
      maxFeePerGas: baseFee.mul(12).div(10).add(priority),
    };
  }

  private getClient(): ClobClient {
    if (!this.clobClient) {
      throw new Error('LiveTradingClient is not initialized');
    }
    return this.clobClient;
  }
}
