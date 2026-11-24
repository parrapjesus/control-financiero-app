// ==============================================================================
// CONFIGURACIÓN DEL CLIENTE SUPABASE + GOOGLE SHEETS DIRECTO
// ==============================================================================
// Permite inicializar Supabase y lectura directa de Google Sheets usando
// valores predeterminados seguros con respaldo en LocalStorage.
// ==============================================================================

const DEFAULT_SUPABASE_URL = 'https://kqoofxosufvhlsotxwdh.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_p0w_8FgEhUGP95ZosgAs0w_TK34GghL';
const DEFAULT_GOOGLE_SHEET_ID = '1OBFnppMCrYsx778162neKEu93B_vsAz1TrMMMsBwKDo';

const SupabaseConfig = {
  getUrl: () => {
    const saved = (localStorage.getItem('CFP_SUPABASE_URL') || window.__ENV_SUPABASE_URL__ || '').trim();
    if (saved && /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(saved)) {
      return saved.replace(/\/+$/, '');
    }
    return DEFAULT_SUPABASE_URL;
  },

  getKey: () => {
    const saved = (localStorage.getItem('CFP_SUPABASE_ANON_KEY') || window.__ENV_SUPABASE_ANON_KEY__ || '').trim();
    if (saved && saved.length >= 20) {
      return saved;
    }
    return DEFAULT_SUPABASE_ANON_KEY;
  },

  getSheetsSyncUrl: () => (localStorage.getItem('CFP_SHEETS_SYNC_URL') || window.__ENV_SHEETS_SYNC_URL__ || '').trim(),

  // Devuelve URL de Apps Script SOLO si es un endpoint Web App válido (/macros/s/.../exec)
  getAppsScriptWebAppUrl: () => {
    const raw = SupabaseConfig.getSheetsSyncUrl();
    if (/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(\?.*)?$/i.test(raw)) {
      return raw;
    }
    return '';
  },

  // Obtiene el ID del Google Sheet (extraído si el usuario pegó el link del Sheet, o el predeterminado)
  getGoogleSheetId: () => {
    const raw = SupabaseConfig.getSheetsSyncUrl();
    const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/);
    if (match && match[1]) return match[1];
    const savedId = (localStorage.getItem('CFP_GOOGLE_SHEET_ID') || '').trim();
    return savedId || DEFAULT_GOOGLE_SHEET_ID;
  },

  saveCredentials: (url, anonKey) => {
    const cleanUrl = (url || '').trim().replace(/\/+$/, '');
    const cleanKey = (anonKey || '').trim();
    if (cleanUrl) localStorage.setItem('CFP_SUPABASE_URL', cleanUrl);
    else localStorage.removeItem('CFP_SUPABASE_URL');
    if (cleanKey) localStorage.setItem('CFP_SUPABASE_ANON_KEY', cleanKey);
    else localStorage.removeItem('CFP_SUPABASE_ANON_KEY');
    SupabaseConfig.client = null;
    SupabaseConfig.init();
  },

  saveSheetsSyncUrl: (url) => {
    const clean = (url || '').trim();
    if (clean) {
      localStorage.setItem('CFP_SHEETS_SYNC_URL', clean);
    } else {
      localStorage.removeItem('CFP_SHEETS_SYNC_URL');
    }
    return clean;
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
