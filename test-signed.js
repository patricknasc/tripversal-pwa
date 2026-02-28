const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
sb.storage.from('social-media').createSignedUploadUrl('test.mp4').then(console.log).catch(console.error);
