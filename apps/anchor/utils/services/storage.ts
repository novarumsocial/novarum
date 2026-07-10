import { S3Client } from 'bun';
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
} = getConfig().files;

export const storage = new S3Client({
  accessKeyId: s3_access_key,
  secretAccessKey: s3_secret_key,
  endpoint: s3_endpoint,
  region: s3_region,
  bucket: s3_bucket,
  virtualHostedStyle: s3_virtual_hosted_style,
});

export async function configureStorageCors() {
  if (!s3_endpoint || !s3_bucket || !s3_region) {
    throw new Error('S3 endpoint, bucket, and region are required to configure storage CORS');
  }

  const url = new URL(s3_endpoint);
  if (s3_virtual_hosted_style) {
    url.hostname = `${s3_bucket}.${url.hostname}`;
    url.pathname = '/';
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(s3_bucket)}`;
  }
  url.search = 'cors';

  const corsRules = s3_cors_origins
    .map((origin) => `<AllowedOrigin>${escapeXml(origin)}</AllowedOrigin>`)
    .join('');
  const body = `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule>${corsRules}<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
  const client = new AwsClient({
    accessKeyId: s3_access_key,
    secretAccessKey: s3_secret_key,
    region: s3_region,
    service: 's3',
  });
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
