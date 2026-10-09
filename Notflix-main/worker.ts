// Cloudflare Workers Full-Stack API & Static Asset Router
// Runs seamlessly on *.workers.dev and custom domains

interface Env {
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  TMDB_API_KEY?: string;
  SCRAPER_PRIMARY_URL?: string;
  SCRAPER_CINEPRO_URL?: string;
  SCRAPER_TMDB_EMBED_URL?: string;
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const DEFAULT_TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8';
const DEFAULT_SCRAPER_CINEPRO = 'http://62.171.179.144:3000';
const DEFAULT_SCRAPER_TMDB_EMBED = 'http://62.171.179.144:3005';
const DEFAULT_COOLIFY_GATEWAY = 'http://kufenvi0cy9unwwgipjiluoh.62.171.179.144.sslip.io';

const ADULT_BLOCKLIST = [
  'romance', 'romantic', 'rom-com', 'erotic', 'sexy', 'sensual', 'love story', 'erotica', 'nsfw',
  'porn', 'pornography', 'xxx', 'sensuality', 'softcore', 'hardcore porn', 'adult content',
  'strip club', 'striptease', 'sexuality', 'fifty shades', 'nude', 'nudity', 'lust', 'seduction',
  'intimate', 'intimacy', 'kama sutra', 'playboy', 'penthouse', 'brazzers', 'bangbros',
  'busty', 'milf', 'stepmom', 'stepmommy', 'stepdad', 'stepsister', 'stepbrother', 'incest',
  'taboo sex', 'fetish', 'bdsm', 'bondage', 'gay', 'lesbian', 'homosexual', 'queer', 'lgbt',
  'bisexual', 'transgender', 'orgasm', 'menage a trois', 'threesome', 'infidelity',
  'love triangle', 'passionate affair', '365 days', '365 dni', 'voyeur', 'erotic thriller',
  'passion', 'passionate', 'affair', 'affaire', 'dating'
];
const safePattern = new RegExp(
  `\\b(${ADULT_BLOCKLIST.join('|')})\\b|\\bsex(?!\\s*(trafficking|crime|worker|trade|slave))\\b`,
  'i'
);

function isSafe(item: any): boolean {
  if (!item) return false;
  if (item.error) return false;
  if (item.adult === true || item.adult === 'true') return false;

  if (item.genre_ids && Array.isArray(item.genre_ids) && item.genre_ids.includes(10749)) return false;
  if (item.genres && Array.isArray(item.genres) && item.genres.some((g: any) => g.id === 10749 || (g.name && g.name.toLowerCase() === 'romance'))) return false;

  const title = (item.title || item.name || '').toLowerCase();
  const desc = (item.overview || item.desc || '').toLowerCase();

  if (title.includes('passion of the christ')) return true;
  if ((title === 'elite' || title === 'élite') && (item.origin_country?.includes('ES') || item.original_name === 'Élite')) {
    return false;
  }

  return !safePattern.test(title) && !safePattern.test(desc);
}

async function fetchWithTimeout(url: string, ms = 25000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function normalizeStreams(data: any, apiName: string, cineproBaseUrl: string = DEFAULT_SCRAPER_CINEPRO) {
  let list: any[] = [];
  if (!data) return list;
  if (Array.isArray(data.streams)) list = data.streams;
  else if (Array.isArray(data.sources)) list = data.sources;
  else if (Array.isArray(data.results)) list = data.results;
  else if (Array.isArray(data.data)) list = data.data;
  else if (Array.isArray(data)) list = data;

  return list
    .map((s) => {
      const rawProvider = s?.provider;
      const providerName =
        rawProvider && typeof rawProvider === 'object'
          ? rawProvider.name || rawProvider.id || apiName
          : rawProvider || s.source || s.name || apiName;

      let streamUrl = s?.url || s?.stream_url || s?.link || s?.playlist || '';
      streamUrl = streamUrl.replace(/http:\/\/localhost:(3000|10000)/g, cineproBaseUrl);

      if (streamUrl.toLowerCase().endsWith('.mkv') || s?.type === 'mkv') {
        return null;
      }

      const quality = (s?.quality || s?.resolution || s?.label || 'AUTO').toUpperCase();
      const isM3U8 =
        !streamUrl.includes('.mp4') &&
        (streamUrl.includes('.m3u8') || !streamUrl.match(/\.(mp4|webm|mkv)/i));

      return {
        url: streamUrl,
        quality,
        provider: providerName,
        intro: s?.intro,
        apiName,
        isM3U8,
        isEmbed: false,
        rawTitle: s?.title || s?.name || '',
        language: s?.lang || s?.language || 'English',
      };
    })
    .filter((s): s is NonNullable<typeof s> => Boolean(s && s.url && s.url.startsWith('http')));
}

function isVidRockOrionStream(s: any): boolean {
  if (!s) return false;
  const prov = (s.provider || '').toString().toLowerCase();
  const rawT = (s.rawTitle || s.title || s.name || '').toString().toLowerCase();
  const url = (s.url || s.stream_url || s.link || s.playlist || '').toString().toLowerCase();
  const proxyUrl = (s.proxyUrl || '').toString().toLowerCase();
  const server = (s.server || s.source || s.apiName || '').toString().toLowerCase();
  const combined = `${prov} ${rawT} ${server}`.toLowerCase();

  // If it's explicitly Atlas, it is not Orion
  if (combined.includes('atlas')) return false;

  // Direct Orion match or crmseraph CDN host
  if (url.includes('crmseraph') || proxyUrl.includes('crmseraph')) {
    return true;
  }
  if (
    combined.includes('vidrockorion') ||
    combined.includes('vidrock-orion') ||
    combined.includes('vidrock_orion')
  ) {
    return true;
  }
  if (combined.includes('vidrock') && combined.includes('orion')) {
    return true;
  }
  if (prov.includes('vidrock') && (rawT.includes('orion') || url.includes('crmseraph'))) {
    return true;
  }
  if (combined.includes('orion')) {
    return true;
  }
  return false;
}

function isIcefyStream(s: any): boolean {
  if (!s) return false;
  if (isVidRockOrionStream(s)) return false;

  const prov = (s.provider || '').toString().toLowerCase();
  const rawT = (s.rawTitle || s.title || s.name || '').toString().toLowerCase();
  const url = (s.url || s.stream_url || s.link || s.playlist || '').toString().toLowerCase();
  const proxyUrl = (s.proxyUrl || '').toString().toLowerCase();
  const server = (s.server || s.source || s.apiName || '').toString().toLowerCase();
  const combined = `${prov} ${rawT} ${server}`.toLowerCase();

  if (combined.includes('icefy')) {
    return true;
  }
  if (
    url.includes('1x2.space') ||
    proxyUrl.includes('1x2.space') ||
    url.includes('mov3.4pa.top') ||
    proxyUrl.includes('mov3.4pa.top') ||
    url.includes('professionaladvisory.sbs') ||
    proxyUrl.includes('professionaladvisory.sbs') ||
    url.includes('tik.1x2') ||
    url.includes('vip.1x2')
  ) {
    return true;
  }
  return false;
}

function isLMScriptStream(s: any): boolean {
  if (!s) return false;
  if (isVidRockOrionStream(s) || isIcefyStream(s)) return false;

  const prov = (s.provider || '').toString().toLowerCase();
  const rawT = (s.rawTitle || s.title || s.name || '').toString().toLowerCase();
  const url = (s.url || s.stream_url || s.link || s.playlist || '').toString().toLowerCase();
  const proxyUrl = (s.proxyUrl || '').toString().toLowerCase();
  const server = (s.server || s.source || s.apiName || '').toString().toLowerCase();
  const combined = `${prov} ${rawT} ${server}`.toLowerCase();

  if (
    combined.includes('lmscript') ||
    combined.includes('lm script') ||
    combined.includes('lm-script') ||
    combined.includes('lm_script')
  ) {
    return true;
  }
  if (url.includes('neward.cyou') || proxyUrl.includes('neward.cyou')) {
    return true;
  }
  return false;
}

function rankStreams(streams: any[], _isTV: boolean) {
  const foreignRegex =
    /\b(PUNJABI|KANNADA|MALAYALAM|TELUGU|TAMIL|BENGALI|MARATHI|GUJARATI|URDU|HINDI|LATINO|ESPANOL|SPANISH|CASTILIAN|FRENCH|VF|VFF|RUSSIAN|GERMAN|DEUTSCH|ITALIAN)\b/i;
  const englishRegex = /\b(ENG|ENGLISH|ORIGINAL|VO)\b/i;
  const multiRegex = /\b(MULTI|DUAL)\b/i;

  const getRank = (s: any) => {
    // 1. Primary Source Prioritization Tier:
    // Tier 0: VidRock Orion (Highest Priority - Always First if available)
    // Tier 1: Icefy (Second Priority - Follows VidRock Orion if available)
    // Tier 2: LMScript (Third Priority - Follows Icefy if available)
    // Tier 3: Other providers (TMDB Embed, Primary, etc.)
    let tierScore = 3;
    if (isVidRockOrionStream(s)) {
      tierScore = 0;
    } else if (isIcefyStream(s)) {
      tierScore = 1;
    } else if (isLMScriptStream(s)) {
      tierScore = 2;
    } else {
      tierScore = 3;
    }

    const rawT = (s.rawTitle || s.title || s.name || '').toString().toUpperCase();
    const prov = (s.provider || '').toString().toUpperCase();
    const lang = (s.language || '').toString().toUpperCase();
    const q = (s.quality || '').toString().toUpperCase();
    const aName = (s.apiName || '').toString().toLowerCase();

    const fullText = `${rawT} ${prov} ${lang}`;

    const isExplicitEnglish =
      englishRegex.test(fullText) ||
      lang === 'EN' ||
      lang === 'ENG' ||
      lang === 'ENGLISH';

    const isExplicitForeignOnly = foreignRegex.test(fullText) && !isExplicitEnglish;
    const isMultiAudio = multiRegex.test(fullText);

    let langScore = 2;
    if (isExplicitEnglish) {
      langScore = 0;
    } else if (isMultiAudio) {
      langScore = 1;
    } else if (isExplicitForeignOnly) {
      langScore = 4;
    } else {
      langScore = 2;
    }

    let pScore = 50;
    if (aName.includes('cinepro') || prov.includes('CINEPRO')) pScore = 1;
    else if (aName.includes('primary') || prov.includes('PRIMARY')) pScore = 2;
    else if (prov.includes('TORRENTIO')) pScore = 3;

    let qScore = 500;
    if (q.includes('LORDFIX')) qScore = 0;
    else if (q.includes('1080') || q.includes('FHD')) qScore = 10;
    else if (q.includes('2160') || q.includes('4K') || q.includes('UHD')) qScore = 20;
    else if (q.includes('720') || q.includes('HD')) qScore = 30;
    else if (q.includes('480')) qScore = 40;
    else if (q.includes('360')) qScore = 50;
    else if (q === 'AUTO') qScore = 60;

    return tierScore * 100000000000 + langScore * 10000000 + pScore * 10000 + qScore;
  };

  const sorted = [...streams].sort((a, b) => getRank(a) - getRank(b));

  // Keep server names completely anonymous as Server 1, Server 2, Server 3, etc.
  return sorted.map((s, idx) => {
    const anonymousName = `Server ${idx + 1}`;
    const cleaned = { ...s };
    delete cleaned.rawTitle;
    delete cleaned.title;
    delete cleaned.name;
    delete cleaned.source;
    delete cleaned.server;
    delete cleaned.apiName;
    return {
      ...cleaned,
      provider: anonymousName,
      rawTitle: anonymousName,
      name: anonymousName,
      title: anonymousName,
    };
  });
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Health check
    if (pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok', runtime: 'cloudflare-worker' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 2. TMDB Proxy
    if (pathname.startsWith('/api/tmdb/')) {
      try {
        const tmdbPath = pathname.replace('/api/tmdb/', '');
        const tmdbKey = env.TMDB_API_KEY || DEFAULT_TMDB_KEY;
        const targetUrl = new URL(`${TMDB_BASE}/${tmdbPath}`);

        for (const [key, value] of url.searchParams.entries()) {
          targetUrl.searchParams.set(key, value);
        }
        targetUrl.searchParams.set('api_key', tmdbKey);

        const tmdbRes = await fetch(targetUrl.toString());
        if (!tmdbRes.ok) {
          return new Response(await tmdbRes.text(), {
            status: tmdbRes.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const data: any = await tmdbRes.json();
        if (Array.isArray(data.results)) {
          data.results = data.results.filter(isSafe);
        } else if (data.id && !isSafe(data)) {
          return new Response(JSON.stringify({ error: 'This title is restricted.' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        return new Response(JSON.stringify(data), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=300',
          },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || 'TMDB error' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // 3. Streams Aggregation
    if (pathname.startsWith('/api/streams/')) {
      try {
        const parts = pathname.replace('/api/streams/', '').split('/');
        const type = parts[0] || 'movie';
        const id = parts[1] || '';
        const isTV = type === 'tv';
        const s = url.searchParams.get('s') || '1';
        const e = url.searchParams.get('e') || '1';

        const scraperCinepro = (env.SCRAPER_CINEPRO_URL || DEFAULT_SCRAPER_CINEPRO).replace(/^https:\/\//i, 'http://');
        const scraperTmdbEmbed = (env.SCRAPER_TMDB_EMBED_URL || env.SCRAPER_PRIMARY_URL || DEFAULT_SCRAPER_TMDB_EMBED).replace(/^https:\/\//i, 'http://');

        const cineproUrl = isTV
          ? `${scraperCinepro}/v1/tv/${id}/seasons/${s}/episodes/${e}`
          : `${scraperCinepro}/v1/movies/${id}`;

        const tasks: Promise<any>[] = [fetchWithTimeout(cineproUrl, 10000)];

        if (scraperTmdbEmbed && scraperTmdbEmbed !== scraperCinepro) {
          const tmdbEmbedUrl = isTV
            ? `${scraperTmdbEmbed}/api/streams/series/${id}?s=${s}&e=${e}`
            : `${scraperTmdbEmbed}/api/streams/movie/${id}`;
          tasks.push(fetchWithTimeout(tmdbEmbedUrl, 10000));
        }

        const results = await Promise.allSettled(tasks);
        let combined: any[] = [];

        if (results[0].status === 'fulfilled' && results[0].value) {
          combined = combined.concat(normalizeStreams(results[0].value, 'CinePro', scraperCinepro));
        }
        if (results[1] && results[1].status === 'fulfilled' && results[1].value) {
          combined = combined.concat(normalizeStreams(results[1].value, 'TMDB Embed', scraperCinepro));
        }

        // If port 3000 was unreachable or blocked by Cloudflare, query via Coolify standard port 80 gateway
        if (combined.length === 0) {
          const query = isTV ? `?s=${s}&e=${e}` : '';
          const gatewayData = await fetchWithTimeout(
            `${DEFAULT_COOLIFY_GATEWAY}/api/streams/${type}/${id}${query}`,
            30000
          );
          if (gatewayData && Array.isArray(gatewayData.streams) && gatewayData.streams.length > 0) {
            combined = gatewayData.streams;
          }
        }

        // If scrapers are unreachable or returned empty, attach resilient backup streams
        if (combined.length === 0) {
          combined = [
            {
              url: isTV ? `https://vidlink.pro/tv/${id}/${s}/${e}` : `https://vidlink.pro/movie/${id}`,
              quality: '1080P',
              provider: 'Server 1 (Fast)',
              apiName: 'Cloud',
              isM3U8: false,
              isEmbed: true,
              rawTitle: 'VidLink High-Speed Mirror',
              language: 'English',
            },
            {
              url: isTV ? `https://vidsrc.cc/v2/embed/tv/${id}/${s}/${e}` : `https://vidsrc.cc/v2/embed/movie/${id}`,
              quality: '1080P',
              provider: 'Server 2 (HD)',
              apiName: 'Cloud',
              isM3U8: false,
              isEmbed: true,
              rawTitle: 'VidSrc Mirror',
              language: 'English',
            },
            {
              url: isTV ? `https://embed.su/embed/tv/${id}/${s}/${e}` : `https://embed.su/embed/movie/${id}`,
              quality: '1080P',
              provider: 'Server 3 (Multi)',
              apiName: 'Cloud',
              isM3U8: false,
              isEmbed: true,
              rawTitle: 'EmbedSU Mirror',
              language: 'English',
            },
            {
              url: isTV ? `https://multiembed.mov/?video_id=${id}&tmdb=1&s=${s}&e=${e}` : `https://multiembed.mov/?video_id=${id}&tmdb=1`,
              quality: '720P',
              provider: 'Server 4',
              apiName: 'Cloud',
              isM3U8: false,
              isEmbed: true,
              rawTitle: 'MultiEmbed Server',
              language: 'English',
            },
            {
              url: isTV ? `https://autoembed.co/tv/tmdb/${id}-${s}-${e}` : `https://autoembed.co/movie/tmdb/${id}`,
              quality: '720P',
              provider: 'Server 5',
              apiName: 'Cloud',
              isM3U8: false,
              isEmbed: true,
              rawTitle: 'AutoEmbed Server',
              language: 'English',
            },
          ];
        }

        const sorted = rankStreams(combined, isTV);

        return new Response(
          JSON.stringify({
            success: true,
            count: sorted.length,
            streams: sorted,
          }),
          {
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Cache-Control': sorted.length > 0 ? 'public, max-age=300, s-maxage=600' : 'no-store, no-cache, must-revalidate',
              ...(sorted.length === 0 ? { 'Pragma': 'no-cache', 'Expires': '0' } : {}),
            },
          }
        );
      } catch (err: any) {
        return new Response(JSON.stringify({ success: false, error: err.message, streams: [] }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // 4. Subtitles Search & Proxy
    if (pathname === '/api/subtitles/search') {
      const imdbId = url.searchParams.get('imdbId');
      const type = url.searchParams.get('type') || 'movie';
      const s = url.searchParams.get('s') || '1';
      const e = url.searchParams.get('e') || '1';

      if (!imdbId) {
        return new Response(JSON.stringify({ subtitles: [] }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const subUrl =
        type === 'tv'
          ? `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${s}:${e}.json`
          : `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`;

      const data = await fetchWithTimeout(subUrl, 6000) || { subtitles: [] };
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/api/subtitles/proxy') {
      const subUrl = url.searchParams.get('url');
      if (!subUrl) {
        return new Response('URL required', { status: 400 });
      }

      try {
        const subRes = await fetch(subUrl);
        let text = await subRes.text();
        if (!text.trim().startsWith('WEBVTT')) {
          text =
            'WEBVTT\n\n' +
            text
              .replace(/\{\\([ibu])\}/g, '<$1>')
              .replace(/\{\\\/([ibu])\}/g, '</$1>')
              .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        }

        return new Response(text, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/vtt; charset=utf-8',
          },
        });
      } catch {
        return new Response('', { status: 404 });
      }
    }

    // 5. User data
    if (pathname === '/api/user/data' || pathname === '/api/user/sync') {
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fallback: Static Assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
