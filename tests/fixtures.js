// Shared fixture data: a small but realistic slice of the anime world
'use strict';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

function iso(ms) { return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z'); }

function anime(o) {
    return Object.assign({
        malId: o.id,
        english: null,
        japanese: null,
        synonyms: [],
        score: 8.1,
        episodes: 12,
        episodesAired: 12,
        nextEpisodeAt: null,
        season: null,
        airedOn: { year: 2024, date: '2024-01-01' },
        releasedOn: { year: null, date: null },
        poster: { originalUrl: 'https://shikimori.io/p/' + o.id + '.jpg', mainUrl: 'https://shikimori.io/p/' + o.id + '.jpg' },
        related: [],
        popularity: 10
    }, o);
}

const FRIEREN_S1 = anime({
    id: 52991, name: 'Sousou no Frieren', russian: 'Провожающая в последний путь Фрирен',
    english: "Frieren: Beyond Journey's End", japanese: '葬送のフリーレン', kind: 'tv', status: 'released',
    episodes: 28, episodesAired: 28, airedOn: { year: 2023, date: '2023-09-29' }, popularity: 100,
    related: [{ relationKind: 'sequel', relationText: 'Sequel', anime: { id: 59978, kind: 'tv', status: 'ongoing' } }]
});

const FRIEREN_S2 = anime({
    id: 59978, name: 'Sousou no Frieren 2nd Season', russian: 'Провожающая в последний путь Фрирен 2',
    english: "Frieren: Beyond Journey's End Season 2", japanese: '葬送のフリーレン 第2期', kind: 'tv', status: 'ongoing',
    episodes: 10, episodesAired: 3, airedOn: { year: 2026, date: '2026-01-16' }, season: 'winter_2026', popularity: 90,
    related: [{ relationKind: 'prequel', relationText: 'Prequel', anime: { id: 52991, kind: 'tv', status: 'released' } }]
});

const FRIEREN_TMDB = {
    type: 'tv', id: 209867, name_ru: 'Провожающая в последний путь Фрирен', name_en: "Frieren: Beyond Journey's End",
    original_name: '葬送のフリーレン', date: '2023-09-29', alt: ['Sousou no Frieren'], seasons: 2, popularity: 120
};

module.exports = { HOUR, DAY, iso, anime, FRIEREN_S1, FRIEREN_S2, FRIEREN_TMDB };
