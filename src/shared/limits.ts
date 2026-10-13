export const LIMITS = {
  MAX_TABS_PER_REQUEST: 200,
  MIN_GROUP_SIZE: 2,
  MAX_TABS_PER_GROUP: 100,

  MAX_TAB_TITLE_CHARS: 300,
  MAX_PATH_CHARS: 300,
  MAX_GROUP_TITLE_CHARS: 24,
  /**
   * Group titles in the semantic index get a longer cap than the organizer
   * prompt's 24 characters, which truncates real names ("Sheaf search
   * rework"). Changing this changes the document text of opted-in tabs, so it must
   * be accompanied by a `SEMANTIC_DOCUMENT_FORMAT_VERSION` bump: the cap is not
   * part of the compatibility key, precisely so that tabs whose owner never opted
   * in are not re-embedded for a change that cannot affect them.
   */
  MAX_SEARCH_GROUP_TITLE_CHARS: 60,

  MAX_REQUEST_BYTES: 512_000,
  MAX_RESPONSE_BYTES: 256_000,
  MAX_PROVIDER_ERROR_BYTES: 16_000,
  MAX_EMBEDDING_RESPONSE_BYTES: 4_000_000,
  MAX_EMBEDDING_INPUTS_PER_REQUEST: 32,
  MAX_EMBEDDING_INPUT_CHARS: 8_000,
  MAX_EMBEDDING_INPUT_BYTES: 16_000,
  MAX_EMBEDDING_REQUEST_BYTES: 256_000,

  MANUAL_TOTAL_DEADLINE_MS: 240_000,

  SESSION_STORAGE_SOFT_BUDGET_BYTES: 7_500_000,
  SESSION_STORAGE_RESERVE_BYTES: 1_500_000,
} as const;
