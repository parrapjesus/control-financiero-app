// ==============================================================================
// CONFIGURACIÓN DEL CLIENTE SUPABASE
// ==============================================================================
// Permite inicializar Supabase usando credenciales guardadas en LocalStorage
// o variables inyectadas durante el despliegue.
// ==============================================================================

const SupabaseConfig = {
  // Configuración predeterminada o guardada por el usuario
  getUrl: () => localStorage.getItem('CFP_SUPABASE_URL') || window.__ENV_SUPABASE_URL__ || '',
  getKey: () => localStorage.getItem('CFP_SUPABASE_ANON_KEY') || window.__ENV_SUPABASE_ANON_KEY__ || '',

  saveCredentials: (url, anonKey) => {
    if (url) localStorage.setItem('CFP_SUPABASE_URL', url.trim());
    if (anonKey) localStorage.setItem('CFP_SUPABASE_ANON_KEY', anonKey.trim());
    SupabaseConfig.init();
  },

  client: null,

  init: () => {
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
      console.warn('⚠️ Supabase no está configurado aún. Se usarán datos de demostración / LocalStorage.');
    }
    return null;
  },

  isConfigured: () => {
    return Boolean(SupabaseConfig.getUrl() && SupabaseConfig.getKey());
  }
};

// Inicialización automática
window.addEventListener('DOMContentLoaded', () => {
  SupabaseConfig.init();
});
