import crypto from 'node:crypto';
import { S3Client, type S3FilePresignOptions } from 'bun';
import { AwsClient } from 'aws4fetch';
import { getConfig } from '../config';

const {
  s3_access_key,
  s3_secret_key,
  s3_endpoint,
  s3_bucket,
  s3_region,
  s3_virtual_hosted_style,
  s3_cors_origins,
  s3_public_endpoint,
  s3_public_host_rewrite,
  s3_upload_endpoint,
  cdn_signing_secret,
} = getConfig().files;

export const storage = new S3Client({
  accessKeyId: s3_access_key,
  secretAccessKey: s3_secret_key,
  endpoint: s3_endpoint,
  region: s3_region,
  bucket: s3_bucket,
  virtualHostedStyle: s3_virtual_hosted_style,
});

export function publicPresign(key: string, options?: S3FilePresignOptions) {
  if (s3_public_host_rewrite && s3_endpoint && s3_public_endpoint) {
    const url = storage.presign(key, { ...options, endpoint: s3_endpoint });
    const stripTrailingSlash = (u: string) => u.replace(/\/+$/, '');
    return signForCdn(
      url.replace(stripTrailingSlash(s3_endpoint), stripTrailingSlash(s3_public_endpoint)),
      options?.expiresIn
    );
  }
  return signForCdn(
    storage.presign(key, { ...options, endpoint: s3_public_endpoint ?? s3_endpoint }),
    options?.expiresIn
  );
}

// a CDN that caches by path never shows the storage signature to storage on a cache hit,
// so it checks this one instead (and strips it before forwarding).
function signForCdn(presigned: string, expiresIn = 24 * 60 * 60) {
  if (!cdn_signing_secret) return presigned;

  // appended as-is: re-serializing the query could change the storage signature's encoding.
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = crypto
    .createHmac('sha256', cdn_signing_secret)
    .update(`${new URL(presigned).pathname}:${exp}`)
    .digest('hex');
  return `${presigned}${presigned.includes('?') ? '&' : '?'}cdn_exp=${exp}&cdn_sig=${sig}`;
}

// A CDN in front of storage only earns its keep on downloads, and proxying uploads through it
// inherits the proxy's request body size limit. Operators whose storage is directly reachable can
// point uploads past it; everyone else keeps the download endpoint, which may be internal-only.
export function uploadPresign(key: string, options?: S3FilePresignOptions) {
  if (s3_upload_endpoint) {
    return storage.presign(key, { ...options, endpoint: s3_upload_endpoint });
  }
  return publicPresign(key, options);
}

export function noStoreRedirect(url: string) {
  const response = Response.redirect(url);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function configureStorageCors() {
  if (!s3_endpoint || !s3_bucket || !s3_region) {
    throw new Error('S3 endpoint, bucket, and region are required to configure storage CORS');
  }

  const corsRules = s3_cors_origins
    .map(
      (origin) =>
        `<CORSRule><AllowedOrigin>${escapeXml(origin)}</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule>`
    )
    .join('');
  const body = `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${corsRules}</CORSConfiguration>`;

  const client = new AwsClient({
    accessKeyId: s3_access_key,
    secretAccessKey: s3_secret_key,
    region: s3_region,
    service: 's3',
  });

  const url = new URL(s3_endpoint);
  if (s3_virtual_hosted_style) {
    url.hostname = `${s3_bucket}.${url.hostname}`;
    url.pathname = '/';
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(s3_bucket)}`;
  }
  url.search = 'cors';

  const response = await client.fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/xml' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Could not configure S3 CORS (${response.status}): ${await response.text()}`);
  }
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
