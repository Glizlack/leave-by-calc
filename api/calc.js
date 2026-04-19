// Leave-By Calculator API
// FMCSA-compliant departure planner
// Rate limit: 3200 calls/day (enforced via response header)

const MAX_CALLS_PER_DAY = 3200;

// In-memory rate tracker (resets on cold start, best-effort for serverless)
const rateTracker = { count: 0, resetDate: null };

function checkRate() {
  const today = new Date().toISOString().slice(0, 10);
  if (rateTracker.resetDate !== today) {
    rateTracker.count = 0;
    rateTracker.resetDate = today;
  }
  rateTracker.count++;
  return {
    callsToday: rateTracker.count,
    remaining: Math.max(0, MAX_CALLS_PER_DAY - rateTracker.count),
    limit: MAX_CALLS_PER_DAY,
    exceeded: rateTracker.count > MAX_CALLS_PER_DAY
  };
}

// FMCSA Forward Simulation (ported from index.html)
function addHours(date, h) {
  return new Date(date.getTime() + h * 3600000);
}

function simulateForward(startDate, distance, speed, hoursLeft, maxDrive) {
  const maxDuty = 14;
  const breakTrigger = 8;
  const inspectionTime = 0.25; // 15 min
  const breakTime = 0.5;       // 30 min
  const sleepTime = 10;

  let now = new Date(startDate);
  let miles = distance;
  let dutyClock = hoursLeft;
  let driveClock = Math.min(maxDrive, hoursLeft);
  let driveSinceBreak = 0;
  const log = [];

  // Pre-trip if starting fresh
  if (hoursLeft >= 13.999) {
    log.push({ time: now.toISOString(), event: 'Pre-trip inspection (15 min)' });
    now = addHours(now, inspectionTime);
    dutyClock -= inspectionTime;
  }

  let safety = 0;
  while (miles > 0.0001 && safety++ < 20000) {
    // Need break?
    if (driveSinceBreak >= breakTrigger - 1e-6) {
      log.push({ time: now.toISOString(), event: '30-minute break (8-hour rule)' });
      now = addHours(now, breakTime);
      dutyClock -= breakTime;
      driveSinceBreak = 0;
      continue;
    }

    // Out of hours?
    if (driveClock <= 1e-6 || dutyClock <= 1e-6) {
      log.push({ time: now.toISOString(), event: 'Post-trip inspection (15 min)' });
      now = addHours(now, inspectionTime);
      log.push({ time: now.toISOString(), event: '10-hour sleeper berth' });
      now = addHours(now, sleepTime);
      dutyClock = maxDuty;
      driveClock = maxDrive;
      driveSinceBreak = 0;
      log.push({ time: now.toISOString(), event: 'Pre-trip inspection (15 min)' });
      now = addHours(now, inspectionTime);
      dutyClock -= inspectionTime;
      continue;
    }

    const timeToDest = miles / speed;
    const timeToBreak = breakTrigger - driveSinceBreak;
    const leg = Math.min(timeToDest, driveClock, dutyClock, timeToBreak);

    if (leg <= 1e-9) {
      driveSinceBreak = breakTrigger;
      continue;
    }

    const startDrive = new Date(now);
    now = addHours(now, leg);
    miles -= leg * speed;
    dutyClock -= leg;
    driveClock -= leg;
    driveSinceBreak += leg;

    const hrs = Math.floor(leg);
    const mins = Math.round((leg - hrs) * 60);
    log.push({
      time: startDrive.toISOString(),
      event: `Drive ${(leg * speed).toFixed(1)} mi (${hrs}h ${mins}m)`
    });
  }

  // Final post-trip
  log.push({ time: now.toISOString(), event: 'Post-trip inspection (15 min)' });
  now = addHours(now, inspectionTime);

  return { arrival: now.toISOString(), log };
}

// Binary search for latest departure
function findLatestDeparture(arriveByTarget, distance, speed, hoursLeft, maxDrive) {
  const low = new Date(arriveByTarget.getTime() - 14 * 24 * 3600000);
  const high = new Date(arriveByTarget);

  let best = new Date(low);
  for (let i = 0; i < 30; i++) {
    const mid = new Date((low.getTime() + high.getTime()) / 2);
    const result = simulateForward(mid, distance, speed, hoursLeft, maxDrive);
    const arrival = new Date(result.arrival);
    if (arrival.getTime() <= arriveByTarget.getTime() + 60000) {
      best = mid;
      low.setTime(mid.getTime() + 1);
    } else {
      high.setTime(mid.getTime() - 1);
    }
    if (high.getTime() <= low.getTime()) break;
  }
  return best;
}

// API Handler
export default function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Rate limit check
  const rate = checkRate();
  res.setHeader('X-RateLimit-Limit', rate.limit);
  res.setHeader('X-RateLimit-Remaining', rate.remaining);
  res.setHeader('X-RateLimit-Reset', new Date().toISOString().slice(0, 10));

  if (rate.exceeded) {
    return res.status(429).json({
      error: 'Daily rate limit exceeded',
      limit: rate.limit,
      callsToday: rate.callsToday,
      retryAfter: 'next UTC day'
    });
  }

  // Parse params from GET query or POST body
  let params;
  if (req.method === 'POST') {
    params = req.body;
  } else {
    params = req.query;
  }

  const { arriveBy, distance, speed, hoursLeft, maxDrive, fresh, buffer } = params;

  // Validate required fields
  if (!arriveBy || !distance) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: { arriveBy: 'ISO datetime string', distance: 'miles (number)' },
      optional: {
        speed: 'mph (default: 50)',
        hoursLeft: 'hours available (default: 14)',
        maxDrive: '11 or 10.5 (default: 11)',
        fresh: 'true/false - 10h break before trip (default: false)',
        buffer: 'true/false - 30min safety buffer (default: true)'
      },
      example: 'GET /api/calc?arriveBy=2026-04-20T14:00&distance=542'
    });
  }

  const dist = parseFloat(distance);
  const spd = parseFloat(speed) || 50;
  const hrsLeft = parseFloat(hoursLeft) || 14;
  const maxDrv = maxDrive === '10.5' || maxDrive === '10' ? 10.5 : 11;
  const useFresh = fresh === 'true' || fresh === true;
  const useBuffer = buffer !== 'false' && buffer !== false;

  const arriveByDate = new Date(arriveBy);
  if (isNaN(arriveByDate.getTime())) {
    return res.status(400).json({ error: 'Invalid arriveBy datetime' });
  }

  // Calculate
  let driveEndTarget = addHours(arriveByDate, -0.25); // final post-trip
  if (useBuffer) {
    driveEndTarget = addHours(driveEndTarget, -0.5);
  }

  const driveStart = findLatestDeparture(driveEndTarget, dist, spd, hrsLeft, maxDrv);

  const freshReserve = 10.25; // 10h sleep + 15m pre-trip
  let finalDeparture = new Date(driveStart);
  let fullLog = [];

  if (useFresh) {
    finalDeparture = addHours(driveStart, -freshReserve);
    fullLog.push({ time: finalDeparture.toISOString(), event: 'Begin 10-hour sleeper berth (depart fresh)' });
    fullLog.push({ time: addHours(finalDeparture, 10).toISOString(), event: 'Pre-trip inspection (15 min) after fresh break' });
  }

  const sim = simulateForward(driveStart, dist, spd, hrsLeft, maxDrv);
  fullLog = fullLog.concat(sim.log);

  if (useBuffer) {
    fullLog.push({ time: sim.arrival, event: 'Arrive at shipper/receiver – 30-minute safety buffer before appointment' });
    fullLog.push({ time: addHours(new Date(sim.arrival), 0.5).toISOString(), event: 'Must-arrive-by appointment time' });
  } else {
    fullLog.push({ time: sim.arrival, event: 'Arrive at destination (on-time)' });
  }

  const plannedArrival = new Date(sim.arrival);

  return res.status(200).json({
    leaveBy: finalDeparture.toISOString(),
    leaveByFormatted: finalDeparture.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
    }),
    plannedArrival: plannedArrival.toISOString(),
    appointmentTime: arriveByDate.toISOString(),
    bufferMinutes: Math.round((arriveByDate.getTime() - plannedArrival.getTime()) / 60000),
    input: { distance: dist, speed: spd, hoursLeft: hrsLeft, maxDrive: maxDrv, fresh: useFresh, buffer: useBuffer },
    timeline: fullLog,
    rateLimit: { callsToday: rate.callsToday, remaining: rate.remaining, limit: rate.limit }
  });
}
