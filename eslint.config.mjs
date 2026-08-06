import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "build-next/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Transitional API-only migration shims and deprecated dashboard code.
    "src/app/(dashboard)/contacts/page.tsx",
    "src/app/(dashboard)/notifications/page.tsx",
    "src/app/(dashboard)/pipelines/page.tsx",
    "src/app/api/automations/**",
    "src/app/api/flows/**",
    "src/components/broadcasts/step2-select-audience.tsx",
    "src/components/broadcasts/step4-schedule-send.tsx",
    "src/components/contacts/contact-detail-view.tsx",
    "src/components/contacts/import-modal.tsx",
    "src/components/inbox/message-thread.tsx",
    "src/hooks/use-auth.tsx",
    "src/hooks/use-broadcast-sending.ts",
    "src/hooks/use-presence.ts",
    "src/hooks/use-realtime.ts",
    "src/hooks/use-total-unread.ts",
    "src/hooks/use-unread-notifications.ts",
    "src/lib/flows/engine.ts",
    "src/lib/supabase/server.ts",
    "src/shims/**",
  ]),
]);

export default eslintConfig;
