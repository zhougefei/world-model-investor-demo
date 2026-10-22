/*
 * Line-by-line port of vendor/generate_2d_collision_dataset.py:
 * WorldConfig, circle_touches_square, _reflect_after_contact, simulate.
 * web/selfcheck.html replays the generator's own rollouts through this file;
 * keep both in step (re-run tools/make_physics_fixtures.py after any change).
 *
 * Classic script (not an ES module) so the page also runs from file://.
 */
(function () {
  "use strict";

  const CFG = Object.freeze({
    width: 64, height: 64, contextFrames: 32, futureFrames: 16, fps: 8,
    ballRadius: 4, obstacleSide: 10, borderMargin: 3, borderWidth: 2,
    gridSize: 8, speed: 0.65, centerMin: 10.0, centerMax: 54.0,
  });
  const TOTAL_FRAMES = CFG.contextFrames + CFG.futureFrames;
  const INNER_MIN = CFG.borderMargin + CFG.borderWidth + CFG.ballRadius + 1;
  const INNER_MAX_X = CFG.width - CFG.borderMargin - CFG.borderWidth - CFG.ballRadius - 1;
  const INNER_MAX_Y = CFG.height - CFG.borderMargin - CFG.borderWidth - CFG.ballRadius - 1;

  // Status codes shared with demo_backend/scene.py.
  const STATUS = Object.freeze({
    OK: "ok", OUT_OF_RANGE: "out_of_range", BAD_SPEED: "bad_speed",
    INITIAL_OVERLAP: "initial_overlap", WALL: "wall", CONTEXT_COLLISION: "context_collision",
  });

  function clip(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function copysign(mag, sign) {
    const m = Math.abs(mag);
    return sign < 0 || Object.is(sign, -0) ? -m : m;
  }

  function circleTouchesSquare(x, y, ox, oy) {
    const half = CFG.obstacleSide / 2.0;
    const nx = clip(x, ox - half, ox + half);
    const ny = clip(y, oy - half, oy + half);
    const dx = x - nx, dy = y - ny;
    return dx * dx + dy * dy <= CFG.ballRadius * CFG.ballRadius;
  }

  function reflectAfterContact(proposed, velocity, obstacle) {
    const [ox, oy] = obstacle;
    const dx = proposed[0] - ox, dy = proposed[1] - oy;
    const half = CFG.obstacleSide / 2.0;
    let hitX = Math.abs(dx) >= half + CFG.ballRadius - 0.75;
    let hitY = Math.abs(dy) >= half + CFG.ballRadius - 0.75;
    if (!hitX && !hitY) {
      if (Math.abs(dx) >= Math.abs(dy)) hitX = true; else hitY = true;
    }
    const reflected = velocity.slice();
    if (hitX) reflected[0] *= -1.0;
    if (hitY) reflected[1] *= -1.0;
    const epsilon = 1e-3;
    const contact = proposed.slice();
    if (hitX) contact[0] = ox + copysign(half + CFG.ballRadius + epsilon, proposed[0] - ox);
    if (hitY) contact[1] = oy + copysign(half + CFG.ballRadius + epsilon, proposed[1] - oy);
    const next = [contact[0] + reflected[0], contact[1] + reflected[1]];
    return { contact, next, reflected };
  }

  function inside(p) {
    return INNER_MIN <= p[0] && p[0] <= INNER_MAX_X && INNER_MIN <= p[1] && p[1] <= INNER_MAX_Y;
  }

  /*
   * Mirrors simulate(): returns {states, firstCollision, collisionCount} or,
   * where Python returns None, {rejected: "initial_overlap" | "wall", frame}.
   * ``states[t] = [x, y, vx, vy]`` for t = 0..47.
   */
  function simulate(ball0, obstacle, velocity) {
    let ball = [ball0[0], ball0[1]];
    let vel = [velocity[0], velocity[1]];
    const states = [];
    let first = null;
    let count = 0;
    if (circleTouchesSquare(ball[0], ball[1], obstacle[0], obstacle[1])) {
      return { rejected: STATUS.INITIAL_OVERLAP, frame: 0, states };
    }
    for (let f = 0; f < TOTAL_FRAMES; f++) {
      if (f > 0) {
        const proposed = [ball[0] + vel[0], ball[1] + vel[1]];
        if (!inside(proposed)) return { rejected: STATUS.WALL, frame: f, states };
        if (circleTouchesSquare(proposed[0], proposed[1], obstacle[0], obstacle[1])) {
          if (first === null) first = f;
          count += 1;
          const r = reflectAfterContact(proposed, vel, obstacle);
          ball = r.contact;
          vel = r.reflected;
          if (!(inside(ball) && inside(r.next))) return { rejected: STATUS.WALL, frame: f, states };
        } else {
          ball = proposed;
        }
      }
      states.push([ball[0], ball[1], vel[0], vel[1]]);
    }
    return { states, firstCollision: first, collisionCount: count };
  }

  function velocityFromAngle(deg) {
    const a = (deg * Math.PI) / 180;
    return [CFG.speed * Math.cos(a), CFG.speed * Math.sin(a)];
  }

  /* Same classification as demo_backend/scene.py::simulate_scene. */
  function classify(ball, obstacle, velocity) {
    for (const [x, y] of [ball, obstacle]) {
      if (!(CFG.centerMin <= x && x <= CFG.centerMax && CFG.centerMin <= y && y <= CFG.centerMax)) {
        return { status: STATUS.OUT_OF_RANGE, label: null, firstCollision: null, sim: null };
      }
    }
    if (Math.abs(Math.hypot(velocity[0], velocity[1]) - CFG.speed) > 1e-6) {
      return { status: STATUS.BAD_SPEED, label: null, firstCollision: null, sim: null };
    }
    const sim = simulate(ball, obstacle, velocity);
    if (sim.rejected) return { status: sim.rejected, label: null, firstCollision: null, sim };
    const futureCollision = sim.firstCollision !== null && sim.firstCollision >= CFG.contextFrames;
    if (sim.firstCollision !== null && !futureCollision) {
      return { status: STATUS.CONTEXT_COLLISION, label: null, firstCollision: sim.firstCollision, sim };
    }
    return { status: STATUS.OK, label: futureCollision ? 1 : 0, firstCollision: sim.firstCollision, sim };
  }

  /* Smallest ball-edge to square-edge distance over frames [from, to). UI only. */
  function minGap(states, obstacle, from, to) {
    const half = CFG.obstacleSide / 2.0;
    let best = Infinity;
    for (let t = from; t < Math.min(to, states.length); t++) {
      const [x, y] = states[t];
      const dx = x - clip(x, obstacle[0] - half, obstacle[0] + half);
      const dy = y - clip(y, obstacle[1] - half, obstacle[1] + half);
      best = Math.min(best, Math.hypot(dx, dy) - CFG.ballRadius);
    }
    return best;
  }

  window.WM = window.WM || {};
  window.WM.physics = {
    CFG, TOTAL_FRAMES, STATUS, INNER_MIN, INNER_MAX_X, INNER_MAX_Y,
    circleTouchesSquare, simulate, classify, velocityFromAngle, minGap,
  };
})();
