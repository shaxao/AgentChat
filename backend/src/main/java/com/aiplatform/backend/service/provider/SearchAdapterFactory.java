package com.aiplatform.backend.service.provider;

import com.aiplatform.backend.service.provider.doubao.DoubaoSearchAdapter;

public class SearchAdapterFactory {

    private static final DoubaoSearchAdapter DOUBAO = new DoubaoSearchAdapter();

    private SearchAdapterFactory() {}

    public static SearchAdapter getAdapter(String provider) {
        if (isDoubao(provider)) {
            return DOUBAO;
        }
        throw new IllegalArgumentException("Unsupported search provider: " + provider);
    }

    public static boolean supportsSearch(String provider) {
        return isDoubao(provider);
    }

    private static boolean isDoubao(String provider) {
        return provider != null
                && (provider.equalsIgnoreCase("doubao")
                || provider.equalsIgnoreCase("Doubao")
                || provider.equals("\u8c46\u5305"));
    }
}
