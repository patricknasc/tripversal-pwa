# Refactor: Weather Icons & Social Stream Uploads (Feb 28, 2026)

## 1. Local Weather Render Fix (`app/TripversalApp.tsx`)
**Issue**: Weather icons for past or upcoming dates outside the active trip's strictly defined `startDate` and `endDate` boundaries (for instance, the prep days before a trip) were omitted, because the caching and fetch logic explicitly constrained queried dates to `historyStart`.
**Solution**: 
- We refactored the `ItineraryScreen` component to first generate a complete `dateRange` array containing every dynamically rendered day in the UI header.
- The `missingPast` calculator now filters strictly using the comprehensive `dateRange` boundary, ensuring the `Open-Meteo` fetch includes all dynamically injected prep/custom event days.

## 2. Payload Too Large / Video Upload Fix (`app/api/trips/[id]/social/route.ts`)
**Issue**: Vercel Serverless Functions impose a hard 4.5MB limit on incoming request bodies. As `SocialStreamScreen` was previously transmitting `FormData` containing the raw video directly to the Next.js API, large videos instantly crashed with `413 FUNCTION_PAYLOAD_TOO_LARGE`.
**Solution**:
- Adopted a **Direct-to-Cloud Presigned Upload** mechanism.
- The Client (`UploadManager._start`) now makes a lightweight JSON request (`action: 'get_url'`) to the Next API to securely generate a Supabase presigned URL (`createSignedUploadUrl`).
- The Client performs an `XMLHttpRequest` `PUT` to upload the raw binary blob entirely bypassing Next.js/Vercel natively to the S3-compatible Supabase bucket, preserving upload progress events (`ev.loaded / ev.total`).
- Upon a successful `200 OK` from Supabase Storage, the Client reaches back to the Next API (`action: 'finalize'`) to persist the `social_posts` postgres row.
- The `UploadManager` continues to support "Retry" semantics seamlessly, simply invoking the workflow from the start using the referenced `File` object.
