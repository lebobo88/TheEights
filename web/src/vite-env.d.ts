/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ATLAS_API?: string;
  readonly VITE_ATLAS_POLL_MS?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
