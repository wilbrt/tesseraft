import type { Response } from 'express';

export const jsonResponse = (res: Response, status: number, body: unknown): void => {
  res.status(status).type('application/json').send(JSON.stringify(body, null, 2));
};

export const errorBody = (status: number, code: string, message: string, details: Record<string, unknown> = {}) => (
  { status, error: { code, message, details } }
);

export const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return null;
  }
};
