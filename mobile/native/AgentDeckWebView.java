package com.ninjalama.agentdeck;

import android.content.Context;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;
import com.getcapacitor.CapacitorWebView;

/**
 * The app's WebView, telling the keyboard that its text fields take images.
 * Without that Gboard greys out the screenshots and pictures in its clipboard
 * row ("not supported here"). What the keyboard then inserts goes to
 * MediaInputPlugin, which hands it to the web app.
 *
 * Used through res/layout/capacitor_bridge_layout_main.xml, which
 * scripts/patch-android.mjs writes over Capacitor's layout of that name.
 */
public class AgentDeckWebView extends CapacitorWebView {

    private static final String[] MIME_TYPES = { "image/*" };

    public AgentDeckWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    @SuppressWarnings("deprecation")
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection connection = super.onCreateInputConnection(outAttrs);
        if (connection == null) return null;
        EditorInfoCompat.setContentMimeTypes(outAttrs, MIME_TYPES);
        return InputConnectionCompat.createWrapper(connection, outAttrs, (content, flags, opts) -> {
            boolean granted = false;
            if ((flags & InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) {
                try {
                    content.requestPermission();
                    granted = true;
                } catch (Exception e) {
                    return false;
                }
            }
            try {
                String mime = content.getDescription().getMimeTypeCount() > 0 ? content.getDescription().getMimeType(0) : null;
                return MediaInputPlugin.fromKeyboard(content.getContentUri(), mime);
            } finally {
                if (granted) {
                    try {
                        content.releasePermission();
                    } catch (Exception e) {
                        // already released
                    }
                }
            }
        });
    }
}
