// Where things go in an archive folder. Staff see the start page and one folder per channel, each
// holding just its chat page and attachments. Everything the tool keeps for itself is in _data.
export const INDEX_NAME = '_index.html';
export const DATA_DIR = '_data';
export const MANIFEST_PATH = `${DATA_DIR}/_manifest-sha256.txt`;
export const RUN_RECORD_NAME = '_run.json';
export const RUN_RECORD_PATH = `${DATA_DIR}/${RUN_RECORD_NAME}`;

export function transcriptPath(folder: string): string {
  return `${DATA_DIR}/${folder}.json`;
}
