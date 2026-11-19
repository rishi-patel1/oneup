import { generatePuzzle } from './generator';
import type { GenerationRequest, GenerationResponse } from './generationProtocol';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GenerationRequest>) => void) | null;
  postMessage: (response: GenerationResponse) => void;
};

scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({ requestId: data.requestId, ok: true, puzzle: generatePuzzle(data.options) });
  } catch (error) {
    scope.postMessage({ requestId: data.requestId, ok: false, error: error instanceof Error ? error.message : 'The puzzle could not be generated. Try a different seed.' });
  }
};
