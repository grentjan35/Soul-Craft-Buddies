/**
 * Image decoding Web Worker
 * Offloads createImageBitmap calls from main thread to prevent UI jank
 * Falls back gracefully if worker fails or isn't supported
 */

self.onmessage = async function(e) {
    const { id, blob, options } = e.data;
    
    try {
        // Decode the image off the main thread
        const bitmap = await createImageBitmap(blob, options || {});
        
        // Transfer the bitmap back to main thread
        self.postMessage({ id, success: true, bitmap }, [bitmap]);
    } catch (error) {
        // Report failure so main thread can use fallback
        self.postMessage({ 
            id, 
            success: false, 
            error: error.message || 'Image decode failed'
        });
    }
};

// Signal that worker is ready (optional, for debugging)
self.postMessage({ type: 'ready' });
