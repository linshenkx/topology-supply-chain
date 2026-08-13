/**
 * Minimal declarations used only by the existing Cloudflare-compatible preview
 * build. The Alibaba Cloud production build removes these bindings in favour of
 * RDS MySQL and OSS adapters.
 */
declare module "cloudflare:workers" {
  export const env: {
    DB: any;
    FILES: any;
    JOB_TOKEN?: string;
    SMS_WEBHOOK_URL?: string;
    SMS_WEBHOOK_API_KEY?: string;
    EMAIL_WEBHOOK_URL?: string;
    EMAIL_WEBHOOK_API_KEY?: string;
  };
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

type D1Database = any;
