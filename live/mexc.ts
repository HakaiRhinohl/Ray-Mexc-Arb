import crypto from "node:crypto";

const MEXC_BASE_URL = "https://api.mexc.com";

export type MexcDepositRecord = {
  amount: string;
  coin: string;
  network?: string;
  status: number;
  address: string;
  txId: string;
  insertTime: number;
  unlockConfirm?: string;
  confirmTimes?: string;
  memo?: string;
};

export type MexcAccount = {
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  accountType: string;
  balances: {
    asset: string;
    free: string;
    locked: string;
  }[];
  permissions: string[];
};

export type MexcSymbolInfo = {
  symbol: string;
  status: string;
  baseAsset: string;
  baseAssetPrecision: number;
  quoteAsset: string;
  quotePrecision: number;
  quoteAssetPrecision: number;
  orderTypes: string[];
  isSpotTradingAllowed: boolean;
  quoteAmountPrecision?: string;
  baseSizePrecision?: string;
  quoteAmountPrecisionMarket?: string;
  maxQuoteAmountMarket?: string;
  takerCommission?: string;
};

export type MexcExchangeInfo = {
  symbols: MexcSymbolInfo[];
};

export type MexcOrder = {
  symbol: string;
  orderId: number | string;
  orderListId?: number;
  clientOrderId: string;
  price: string;
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  status: "NEW" | "FILLED" | "PARTIALLY_FILLED" | "CANCELED" | "PARTIALLY_CANCELED" | string;
  timeInForce?: string;
  type: string;
  side: string;
  stopPrice?: string;
  time?: number;
  updateTime?: number;
  isWorking?: boolean;
  origQuoteOrderQty?: string;
};

export type MexcTrade = {
  symbol: string;
  id: string;
  orderId: string;
  orderListId?: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
  isBestMatch?: boolean;
  isSelfTrade?: boolean;
  clientOrderId?: string | null;
};

export class MexcSignedClient {
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string
  ) {}

  async signedGet<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const query = this.signParams(params);
    const response = await fetch(`${MEXC_BASE_URL}${path}?${query}`, {
      headers: {
        "X-MEXC-APIKEY": this.apiKey
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`MEXC ${response.status} ${response.statusText}: ${body}`);
    }

    return (await response.json()) as T;
  }

  async signedPost<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const query = this.signParams(params);
    const response = await fetch(`${MEXC_BASE_URL}${path}?${query}`, {
      method: "POST",
      headers: {
        "X-MEXC-APIKEY": this.apiKey
      }
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(`MEXC ${response.status} ${response.statusText}: ${responseBody}`);
    }

    return (await response.json()) as T;
  }

  async fetchExchangeInfo(symbol: string): Promise<MexcSymbolInfo> {
    const response = await fetch(`${MEXC_BASE_URL}/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`MEXC exchangeInfo ${response.status} ${response.statusText}: ${body}`);
    }

    const data = (await response.json()) as MexcExchangeInfo;
    const symbolInfo = data.symbols.find((item) => item.symbol === symbol);
    if (!symbolInfo) throw new Error(`MEXC symbol not found in exchangeInfo: ${symbol}`);
    return symbolInfo;
  }

  async fetchAccount(): Promise<MexcAccount> {
    return this.signedGet<MexcAccount>("/api/v3/account", {
      recvWindow: 5000,
      timestamp: Date.now()
    });
  }

  async fetchFreeBalance(asset: string): Promise<string> {
    const account = await this.fetchAccount();
    const balance = account.balances.find((item) => item.asset.toUpperCase() === asset.toUpperCase());
    return balance?.free ?? "0";
  }

  async createMarketSell(args: {
    symbol: string;
    quantity: string;
    newClientOrderId: string;
  }): Promise<MexcOrder> {
    return this.signedPost<MexcOrder>("/api/v3/order", {
      symbol: args.symbol,
      side: "SELL",
      type: "MARKET",
      quantity: args.quantity,
      newClientOrderId: args.newClientOrderId,
      recvWindow: 5000,
      timestamp: Date.now()
    });
  }

  async fetchOrder(args: {
    symbol: string;
    orderId?: string | number;
    origClientOrderId?: string;
  }): Promise<MexcOrder> {
    return this.signedGet<MexcOrder>("/api/v3/order", {
      symbol: args.symbol,
      orderId: args.orderId,
      origClientOrderId: args.origClientOrderId,
      recvWindow: 5000,
      timestamp: Date.now()
    });
  }

  async fetchMyTrades(args: {
    symbol: string;
    orderId?: string | number;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<MexcTrade[]> {
    return this.signedGet<MexcTrade[]>("/api/v3/myTrades", {
      symbol: args.symbol,
      orderId: args.orderId,
      startTime: args.startTime,
      endTime: args.endTime,
      limit: args.limit ?? 100,
      recvWindow: 5000,
      timestamp: Date.now()
    });
  }

  async fetchDeposits(args: {
    coin?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<MexcDepositRecord[]> {
    return this.signedGet<MexcDepositRecord[]>("/api/v3/capital/deposit/hisrec", {
      coin: args.coin,
      startTime: args.startTime,
      endTime: args.endTime,
      limit: args.limit ?? 100,
      timestamp: Date.now()
    });
  }

  private signParams(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      search.set(key, String(value));
    }

    if (!search.has("timestamp")) {
      search.set("timestamp", String(Date.now()));
    }

    const payload = search.toString();
    const signature = crypto.createHmac("sha256", this.apiSecret).update(payload).digest("hex");
    search.set("signature", signature);
    return search.toString();
  }
}
