import i18n from 'i18next';
import Backend from 'i18next-fs-backend';
import * as path from 'path';
import { app } from 'electron';

// Initialize i18next for main process
export async function initI18n(locale?: string): Promise<void> {
    let userLocale = locale;
    
    // If no locale provided, try to get from app (if available) or use system locale
    if (!userLocale) {
        try {
            userLocale = app.getLocale();
        } catch {
            // App might not be ready yet
            userLocale = process.env.LANG?.split('.')[0]?.split('_')[0] || 'en';
        }
    }
    
    // Normalize locale (e.g., 'en-US' -> 'en')
    if (userLocale) {
        userLocale = userLocale.split('-')[0].toLowerCase();
    }
    
    // Fallback to 'en' if locale not supported
    const supportedLocales = ['en', 'fr', 'es', 'zh', 'hi', 'ar', 'de', 'it', 'pt'];
    if (!supportedLocales.includes(userLocale || '')) {
        userLocale = 'en';
    }
    
    const localesPath = path.join(__dirname, 'locales', '{{lng}}.json');
    
    await i18n
        .use(Backend)
        .init({
            lng: userLocale || 'en',
            fallbackLng: 'en',
            backend: {
                loadPath: localesPath,
            },
            interpolation: {
                escapeValue: false,
            },
            debug: false,
        });
}

// Check if i18n is initialized
export function isInitialized(): boolean {
    return i18n.isInitialized;
}

// Get translation function
export function t(key: string, options?: any): string {
    if (!i18n.isInitialized) {
        console.warn(`[i18n] Not initialized, returning key: ${key}`);
        return key;
    }
    
    try {
        const translation = i18n.t(key, options);
        // Check if translation failed (returned the key itself)
        if (translation === key) {
            console.warn(`[i18n] Translation not found for key: ${key} (language: ${i18n.language})`);
            // Try fallback to English
            if (i18n.language !== 'en') {
                const fallback = i18n.t(key, { ...options, lng: 'en' });
                if (fallback !== key) {
                    return fallback as string;
                }
            }
        }
        return translation as string;
    } catch (error) {
        console.error(`[i18n] Error translating key ${key}:`, error);
        return key;
    }
}

// Change language
export async function changeLanguage(locale: string): Promise<void> {
    await i18n.changeLanguage(locale);
}

// Get current language
export function getCurrentLanguage(): string {
    return i18n.language;
}

// Get available languages
export function getAvailableLanguages(): string[] {
    return ['en', 'fr', 'es', 'zh', 'hi', 'ar', 'de', 'it', 'pt'];
}

export default i18n;
