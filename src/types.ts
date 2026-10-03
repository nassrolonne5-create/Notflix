export interface MediaItem {
  id: number;
  title?: string;
  name?: string;
  year?: string;
  rating?: string | number;
  vote_average?: number;
  type: 'movie' | 'tv';
  media_type?: 'movie' | 'tv';
  poster: string;
  poster_path?: string;
  backdrop?: string;
  backdrop_path?: string;
  overview?: string;
  desc?: string;
  genre_ids?: number[];
  adult?: boolean;
  imdb_id?: string;
  watchedAt?: string;
}

export interface Genre {
  id: number;
  name: string;
}

export interface Season {
  season_number: number;
  episode_count: number;
  name?: string;
  air_date?: string;
}

export interface Episode {
  episode_number: number;
  name: string;
  overview?: string;
  air_date?: string;
  still_path?: string;
}

export interface StreamSource {
  url: string;
  quality: string;
  provider: string;
  language?: string;
  apiName?: string;
  isM3U8?: boolean;
  isEmbed?: boolean;
  rawTitle?: string;
  intro?: {
    start?: number;
    end?: number;
  };
}

export interface SubtitleTrack {
  id?: string;
  lang: string;
  url: string;
}

export interface CastMember {
  id: number;
  name: string;
  character?: string;
  profile_path?: string;
}

export interface UserPlaybackData {
  time?: number;
  duration?: number;
  s?: number;
  e?: number;
  watched?: string[];
  subLabel?: string;
  audioLanguage?: string;
  audioId?: string;
  [key: string]: any;
}

export interface UserData {
  watchlist: MediaItem[];
  favorites: MediaItem[];
  history: MediaItem[];
  playbackPosition: Record<string, UserPlaybackData>;
  settings: {
    autoSkip: boolean;
    globalSubtitles: boolean;
  };
}
