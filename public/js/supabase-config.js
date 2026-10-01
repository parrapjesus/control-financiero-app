// ==============================================================================
// CONFIGURACIÓN DEL CLIENTE SUPABASE
// ==============================================================================
// Permite inicializar Supabase usando credenciales guardadas en LocalStorage
// o variables inyectadas durante el despliegue.
// ==============================================================================

const SupabaseConfig = {
  // Configuración predeterminada o guardada por el usuario
  getUrl: () => localStorage.getItem('CFP_SUPABASE_URL') || window.__ENV_SUPABASE_URL__ || 'https://kqoofxosufvhlsotxwdh.supabase.co',
  getKey: () => localStorage.getItem('CFP_SUPABASE_ANON_KEY') || window.__ENV_SUPABASE_ANON_KEY__ || 'sb_publishable_p0w_8FgEhUGP95ZosgAs0w_TK34GghL',

  saveCredentials: (url, anonKey) => {
    if (url) localStorage.setItem('CFP_SUPABASE_URL', url.trim());
    if (anonKey) localStorage.setItem('CFP_SUPABASE_ANON_KEY', anonKey.trim());
    SupabaseConfig.init();
  },

  client: null,

  init: () => {
    if (SupabaseConfig.client) return SupabaseConfig.client;
    const url = SupabaseConfig.getUrl();
    const key = SupabaseConfig.getKey();

    if (url && key && window.supabase) {
      try {
        SupabaseConfig.client = window.supabase.createClient(url, key, {
          auth: {
            persistSession: true,
            autoRefreshToken: true
          }
        });
        console.log('✅ Supabase Client conectado con éxito:', url);
        return SupabaseConfig.client;
      } catch (err) {
        console.error('❌ Error al inicializar Supabase:', err);
      }
    } else {
      console.warn('⚠️ Supabase SDK aún no disponible o credenciales incompletas.');
    }
    return null;
  },

  isConfigured: () => {
    return Boolean(SupabaseConfig.getUrl() && SupabaseConfig.getKey());
  }
};

// Inicialización inmediata y en DOMContentLoaded
if (typeof window !== 'undefined' && window.supabase) {
  SupabaseConfig.init();
}
window.addEventListener('DOMContentLoaded', () => {
  SupabaseConfig.init();
});
