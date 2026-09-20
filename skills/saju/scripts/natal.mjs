#!/usr/bin/env node
// natal.mjs — 네이탈 차트 계산 CLI (tune4unni engine.ts 포팅, 트로피컬+Whole Sign)
// 사용법:
//   node natal.mjs '{"year":1998,"month":10,"day":27,"hour":20,"minute":0,"latitude":37.5665,"longitude":126.978,"timezone":"Asia/Seoul"}'
//   echo '{...}' | node natal.mjs
//   node natal.mjs --synastry '{"person1":{...},"person2":{...}}'
// 출력: 네이탈 차트 JSON (행성 별자리/하우스/어스펙트/ASC·MC)
import * as Astronomy from 'astronomy-engine';

const { Body, EclipticLongitude, Equator, Horizon, SiderealTime, Observer } = Astronomy;

const ZODIAC_SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo','Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'];
const ZODIAC_KO = {Aries:'양자리',Taurus:'황소자리',Gemini:'쌍둥이자리',Cancer:'게자리',Leo:'사자자리',Virgo:'처녀자리',Libra:'천칭자리',Scorpio:'전갈자리',Sagittarius:'사수자리',Capricorn:'염소자리',Aquarius:'물병자리',Pisces:'물고기자리'};

const PLANETS = [
  { name: 'Sun', body: Body.Sun }, { name: 'Moon', body: Body.Moon },
  { name: 'Mercury', body: Body.Mercury }, { name: 'Venus', body: Body.Venus },
  { name: 'Mars', body: Body.Mars }, { name: 'Jupiter', body: Body.Jupiter },
  { name: 'Saturn', body: Body.Saturn }, { name: 'Uranus', body: Body.Uranus },
  { name: 'Neptune', body: Body.Neptune }, { name: 'Pluto', body: Body.Pluto },
];

const ASPECTS = [
  { type: 'conjunction', angle: 0, orb: 8, weight: 8 },
  { type: 'opposition', angle: 180, orb: 8, weight: -6 },
  { type: 'trine', angle: 120, orb: 6, weight: 7 },
  { type: 'square', angle: 90, orb: 6, weight: -5 },
  { type: 'sextile', angle: 60, orb: 5, weight: 4 },
];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const normalizeDegree = (v) => { const n = v % 360; return n < 0 ? n + 360 : n; };
const zodiacSignForLongitude = (lon) => ZODIAC_SIGNS[Math.floor(normalizeDegree(lon) / 30)] ?? 'Aries';
const degreeInSign = (lon) => Number((normalizeDegree(lon) % 30).toFixed(4));
const num = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };

const normalizeBirthInput = (raw) => ({
  name: String(raw.name || 'User'),
  year: num(raw.year), month: num(raw.month), day: num(raw.day),
  hour: raw.isTimeUnknown ? 12 : num(raw.hour, 12),
  minute: raw.isTimeUnknown ? 0 : num(raw.minute, 0),
  isTimeUnknown: Boolean(raw.isTimeUnknown),
  city: String(raw.city || raw.location || 'Unknown'),
  latitude: num(raw.latitude), longitude: num(raw.longitude),
  timezone: String(raw.timezone || 'Asia/Seoul'),
});

const localPartsForUtc = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day'),
           hour: get('hour') === 24 ? 0 : get('hour'), minute: get('minute'), second: get('second') };
};

const zonedTimeToUtc = (input) => {
  const t = { year: input.year, month: input.month, day: input.day, hour: input.hour, minute: input.minute };
  const targetMs = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, 0);
  let utcMs = targetMs;
  for (let i = 0; i < 3; i++) {
    const o = localPartsForUtc(new Date(utcMs), input.timezone);
    const diff = Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second)
               - targetMs;
    if (diff === 0) break;
    utcMs -= diff;
  }
  // DST edge warnings: this CLI resolves silently; surface the policy used.
  const resolved = localPartsForUtc(new Date(utcMs), input.timezone);
  const resolvedMs = Date.UTC(resolved.year, resolved.month - 1, resolved.day, resolved.hour, resolved.minute, resolved.second);
  if (resolvedMs !== targetMs) {
    process.stderr.write(`[natal] warning: ${input.timezone} local time does not exist (DST gap); resolved to ${resolved.year}-${String(resolved.month).padStart(2, '0')}-${String(resolved.day).padStart(2, '0')} ${String(resolved.hour).padStart(2, '0')}:${String(resolved.minute).padStart(2, '0')}\n`);
  } else {
    // Ambiguous fold: another instant maps to the same local time.
    for (const probe of [utcMs - 3600000, utcMs + 3600000]) {
      const p = localPartsForUtc(new Date(probe), input.timezone);
      if (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === targetMs) {
        process.stderr.write(`[natal] warning: ${input.timezone} local time is ambiguous (DST fold); resolved to ${new Date(utcMs).toISOString()}\n`);
        break;
      }
    }
  }
  return new Date(utcMs);
};

const houseForLongitude = (lon, asc) => ((Math.floor(normalizeDegree(lon) / 30) - Math.floor(normalizeDegree(asc) / 30) + 12) % 12) + 1;
const wholeSignHouses = (asc) => {
  const s = Math.floor(normalizeDegree(asc) / 30);
  return Array.from({ length: 12 }, (_, i) => {
    const idx = (s + i) % 12;
    return { house: i + 1, sign: ZODIAC_SIGNS[idx], signKo: ZODIAC_KO[ZODIAC_SIGNS[idx]], startLongitude: idx * 30 };
  });
};

const calculateAngles = (date, lat, lon) => {
  const eps = 23.4392911 * Math.PI / 180, phi = lat * Math.PI / 180;
  const theta = normalizeDegree(SiderealTime(date) * 15 + lon) * Math.PI / 180;
  const mc = normalizeDegree(Math.atan2(Math.sin(theta) / Math.cos(eps), Math.cos(theta)) * 180 / Math.PI);
  const asc = normalizeDegree(Math.atan2(-Math.cos(theta), Math.sin(theta) * Math.cos(eps) + Math.tan(phi) * Math.sin(eps)) * 180 / Math.PI);
  return [
    { name: 'ASC', longitude: Number(asc.toFixed(4)), sign: zodiacSignForLongitude(asc), signKo: ZODIAC_KO[zodiacSignForLongitude(asc)], degreeInSign: degreeInSign(asc) },
    { name: 'MC', longitude: Number(mc.toFixed(4)), sign: zodiacSignForLongitude(mc), signKo: ZODIAC_KO[zodiacSignForLongitude(mc)], degreeInSign: degreeInSign(mc) },
  ];
};

const eclipticLongitudeFromEquator = (raH, decD) => {
  const eps = 23.4392911 * Math.PI / 180, ra = raH * 15 * Math.PI / 180, dec = decD * Math.PI / 180;
  return normalizeDegree(Math.atan2(Math.sin(ra) * Math.cos(eps) + Math.tan(dec) * Math.sin(eps), Math.cos(ra)) * 180 / Math.PI);
};

const calculateBodyLongitude = (body, date, observer) => {
  const eq = Equator(body, date, observer, true, true);
  try {
    return { longitude: normalizeDegree(EclipticLongitude(body, date)), rightAscension: eq.ra, declination: eq.dec };
  } catch {
    return { longitude: eclipticLongitudeFromEquator(eq.ra, eq.dec), rightAscension: eq.ra, declination: eq.dec };
  }
};

const findAspects = (planetsA, planetsB = planetsA, crossChart = false) => {
  const out = [];
  planetsA.forEach((a, i) => {
    planetsB.forEach((b, j) => {
      if (!crossChart && j <= i) return;
      const sep = Math.abs(normalizeDegree(a.longitude - b.longitude));
      const shortest = sep > 180 ? 360 - sep : sep;
      const m = ASPECTS.find((x) => Math.abs(shortest - x.angle) <= x.orb);
      if (!m) return;
      out.push({ type: m.type, bodyA: a.body, bodyB: b.body, orb: Number(Math.abs(shortest - m.angle).toFixed(3)) });
    });
  });
  return out.sort((a, b) => a.orb - b.orb);
};

const calculateNatalChart = (rawInput) => {
  const subject = normalizeBirthInput(rawInput);
  const utcDate = zonedTimeToUtc(subject);
  const observer = new Observer(subject.latitude, subject.longitude, 0);
  const angles = calculateAngles(utcDate, subject.latitude, subject.longitude);
  const asc = angles[0]?.longitude ?? 0;

  const planets = PLANETS.map(({ name, body }) => {
    const c = calculateBodyLongitude(body, utcDate, observer);
    const sign = zodiacSignForLongitude(c.longitude);
    return {
      body: name, longitude: Number(c.longitude.toFixed(4)),
      sign, signKo: ZODIAC_KO[sign], degreeInSign: degreeInSign(c.longitude),
      house: houseForLongitude(c.longitude, asc),
    };
  });

  return {
    standard: 'ASTROLOGER_V3_TROPICAL_WHOLE_SIGN',
    subject, utcDate: utcDate.toISOString(),
    angles, houses: wholeSignHouses(asc), planets,
    aspects: findAspects(planets),
  };
};

const calculateSynastry = (a, b) => {
  const first = calculateNatalChart(a), second = calculateNatalChart(b);
  const aspects = findAspects(first.planets, second.planets, true);
  const weighted = aspects.reduce((t, asp) => {
    const rule = ASPECTS.find((c) => c.type === asp.type);
    const closeness = rule ? (rule.orb - asp.orb) / rule.orb : 0;
    return t + (rule?.weight ?? 0) * Math.max(closeness, 0);
  }, 0);
  const score = Math.round(clamp(55 + weighted, 0, 100));
  return { score, aspects,
    summary: score >= 75 ? '강한 조화와 끌림이 보여요.' : score >= 55 ? '서로 맞춰가면 좋아지는 흐름이에요.' : '차이를 이해하는 연습이 중요한 조합이에요.',
    chartA: first, chartB: second };
};

// --- CLI ---
const readInput = async () => {
  const arg = process.argv.find((a, i) => i > 1 && !a.startsWith('--'));
  if (arg) return arg;
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
};

const raw = await readInput();
if (!raw.trim()) {
  console.error('usage: node natal.mjs [--synastry] <json>');
  process.exit(1);
}
const input = JSON.parse(raw);
const result = process.argv.includes('--synastry')
  ? calculateSynastry(input.person1, input.person2)
  : calculateNatalChart(input);
console.log(JSON.stringify(result, null, 2));
