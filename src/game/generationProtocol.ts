import type { GeneratedPuzzle, GenerationOptions } from './generator';

export interface GenerationRequest {
  requestId: number;
  options: GenerationOptions;
}

export type GenerationResponse =
  | { requestId: number; ok: true; puzzle: GeneratedPuzzle }
  | { requestId: number; ok: false; error: string };
