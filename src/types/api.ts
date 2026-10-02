import type { Request } from "express";

/** Uniform error envelope returned by every failing endpoint. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ApiMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface Paginated<T> {
  data: T[];
  meta: ApiMeta;
}

export interface RequestWithUserAgent extends Request {
  requestId?: string;
}
