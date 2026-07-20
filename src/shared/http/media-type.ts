// oz-erp-edge/src/shared/http/media-type.ts
const MEDIA_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const MULTIPART_BOUNDARY_PATTERN = /^[0-9A-Za-z'()+_,./:=?-]{1,70}$/u;

export type ParsedContentType = Readonly<{
  mediaType: string;
  boundary: string | null;
}>;

function parseBoundary(parts: readonly string[]): string | null {
  for (const rawPart of parts) {
    const separatorIndex = rawPart.indexOf('=');
    if (separatorIndex <= 0) continue;

    const name = rawPart.slice(0, separatorIndex).trim().toLowerCase();
    if (name !== 'boundary') continue;

    const rawValue = rawPart.slice(separatorIndex + 1).trim();
    const value =
      rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2
        ? rawValue.slice(1, -1)
        : rawValue;

    return MULTIPART_BOUNDARY_PATTERN.test(value) ? value : null;
  }

  return null;
}

export function parseContentType(value: string | null): ParsedContentType | null {
  if (value === null) return null;

  const parts = value.split(';');
  const mediaType = parts[0]?.trim().toLowerCase() ?? '';
  if (!MEDIA_TYPE_PATTERN.test(mediaType)) return null;

  return {
    mediaType,
    boundary: mediaType === 'multipart/form-data' ? parseBoundary(parts.slice(1)) : null,
  };
}

export function isJsonMediaType(mediaType: string): boolean {
  return /^application\/(?:json|[!#$%&'*+.^_`|~0-9A-Za-z-]+\+json)$/u.test(mediaType);
}
