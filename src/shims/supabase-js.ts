// @deprecated wacrm is API-only — Supabase runtime removed during direct-pg migration.

export type PostgrestError = any;
export type SupabaseClient = any;
export type User = any;
export type RealtimeChannel = any;

function unsupported(): never {
  throw new Error('Supabase removed — wacrm is API-only');
}

function makeBuilder(): any {
  const builder: any = {};
  const chain = () => builder;

  builder.select = chain;
  builder.insert = chain;
  builder.update = chain;
  builder.delete = chain;
  builder.upsert = chain;
  builder.eq = chain;
  builder.neq = chain;
  builder.gt = chain;
  builder.gte = chain;
  builder.lt = chain;
  builder.lte = chain;
  builder.like = chain;
  builder.ilike = chain;
  builder.in = chain;
  builder.or = chain;
  builder.order = chain;
  builder.limit = chain;
  builder.range = chain;
  builder.filter = chain;
  builder.is = chain;
  builder.rpc = async () => unsupported();
  builder.single = async () => unsupported();
  builder.maybeSingle = async () => unsupported();
  builder.then = (_resolve: any, reject?: any) => {
    const err = new Error('Supabase removed — wacrm is API-only');
    if (reject) return reject(err);
    throw err;
  };

  return builder;
}

export function createClient(..._args: unknown[]): SupabaseClient {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: { message: 'Supabase removed — wacrm is API-only' } }),
      getSession: async () => ({ data: { session: null }, error: { message: 'Supabase removed — wacrm is API-only' } }),
      onAuthStateChange: (..._args: unknown[]) => ({
        data: { subscription: { unsubscribe() {} } },
      }),
      signInWithPassword: async () => unsupported(),
      signOut: async () => unsupported(),
      signUp: async () => unsupported(),
      resetPasswordForEmail: async () => unsupported(),
      updateUser: async () => unsupported(),
    },
    from: () => makeBuilder(),
    rpc: async () => unsupported(),
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
      unsubscribe: async () => undefined,
    }),
    removeChannel: async () => undefined,
    storage: {
      from: () => ({
        upload: async () => unsupported(),
        createSignedUrl: async () => unsupported(),
        getPublicUrl: () => unsupported(),
        remove: async () => unsupported(),
        download: async () => unsupported(),
      }),
    },
  };
}
