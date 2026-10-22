/*
 * Drawing for the arena, the reveal canvas and the frame-difference window.
 * Colours and geometry follow render_frame() in the vendored generator, so
 * the picture on screen is the picture the models are trained on.
 */
(function () {
  "use strict";
  const { CFG } = window.WM.physics;

  const COLORS = {
    grid: "rgb(224,224,224)", border: "rgb(155,155,155)",
    obstacleFill: "rgb(57,111,211)", obstacleLine: "rgb(31,73,154)",
    ballFill: "rgb(219,55,63)", ballLine: "rgb(151,26,32)",
  };

  /* Size a canvas to its CSS box at device resolution; returns px per world unit. */
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const cssSize = canvas.clientWidth || canvas.width;
    const px = Math.max(64, Math.round(cssSize * dpr));
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    return { ctx: canvas.getContext("2d"), s: px / CFG.width };
  }

  /* ``faithful`` reproduces the generator's 1-unit strokes; otherwise strokes are lighter for display. */
  function drawWorld(ctx, s, ball, obstacle, opts = {}) {
    const faithful = !!opts.faithful;
    const m = CFG.borderMargin;
    const far = CFG.width - CFG.borderMargin - 1;
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CFG.width * s, CFG.height * s);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = (faithful ? 1 : 0.35) * s;
    ctx.beginPath();
    for (let u = m; u <= far; u += CFG.gridSize) {
      ctx.moveTo(u * s, m * s); ctx.lineTo(u * s, far * s);
      ctx.moveTo(m * s, u * s); ctx.lineTo(far * s, u * s);
    }
    ctx.stroke();
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = CFG.borderWidth * s;
    const inset = m + CFG.borderWidth / 2;
    ctx.strokeRect(inset * s, inset * s, (far + 1 - CFG.borderWidth / 2 - inset) * s, (far + 1 - CFG.borderWidth / 2 - inset) * s);
    if (obstacle) drawObstacle(ctx, s, obstacle, opts.obstacleAlpha);
    if (ball) drawBall(ctx, s, ball, opts.ballAlpha);
    ctx.restore();
  }

  function drawObstacle(ctx, s, [ox, oy], alpha = 1) {
    const half = CFG.obstacleSide / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = COLORS.obstacleFill;
    ctx.fillRect((ox - half) * s, (oy - half) * s, CFG.obstacleSide * s, CFG.obstacleSide * s);
    ctx.strokeStyle = COLORS.obstacleLine;
    ctx.lineWidth = s;
    ctx.strokeRect((ox - half + 0.5) * s, (oy - half + 0.5) * s, (CFG.obstacleSide - 1) * s, (CFG.obstacleSide - 1) * s);
    ctx.restore();
  }

  function drawBall(ctx, s, [x, y], alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x * s, y * s, CFG.ballRadius * s, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.ballFill;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x * s, y * s, (CFG.ballRadius - 0.5) * s, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.ballLine;
    ctx.lineWidth = s;
    ctx.stroke();
    ctx.restore();
  }

  /* Polyline through ball centres of states[from..to]. */
  function drawPath(ctx, s, states, from, to, style) {
    const end = Math.min(to, states.length - 1);
    if (end <= from) return;
    ctx.save();
    ctx.strokeStyle = style.color;
    ctx.lineWidth = (style.width || 0.6) * s;
    ctx.lineCap = "round";
    ctx.setLineDash(style.dash ? style.dash.map((d) => d * s) : []);
    ctx.globalAlpha = style.alpha ?? 1;
    ctx.beginPath();
    ctx.moveTo(states[from][0] * s, states[from][1] * s);
    for (let t = from + 1; t <= end; t++) ctx.lineTo(states[t][0] * s, states[t][1] * s);
    ctx.stroke();
    ctx.restore();
  }

  function drawGhost(ctx, s, [x, y], color) {
    ctx.save();
    ctx.setLineDash([0.9 * s, 0.9 * s]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5 * s;
    ctx.beginPath();
    ctx.arc(x * s, y * s, CFG.ballRadius * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* Direction arrow from the ball; returns the handle position in world units. */
  function drawArrow(ctx, s, [x, y], angleDeg, opts = {}) {
    const a = (angleDeg * Math.PI) / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    let len = opts.length || 13;
    // Shorten so the handle stays on the canvas near the edges.
    while (len > 7) {
      const tx = x + ux * len, ty = y + uy * len;
      if (tx > 2 && tx < CFG.width - 2 && ty > 2 && ty < CFG.height - 2) break;
      len -= 0.5;
    }
    const start = CFG.ballRadius + 0.8;
    const tx = x + ux * len, ty = y + uy * len;
    ctx.save();
    ctx.strokeStyle = opts.color || "#1b1d20";
    ctx.fillStyle = opts.color || "#1b1d20";
    ctx.lineWidth = 0.7 * s;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo((x + ux * start) * s, (y + uy * start) * s);
    ctx.lineTo((tx - ux * 1.6) * s, (ty - uy * 1.6) * s);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tx * s, ty * s);
    ctx.lineTo((tx - ux * 2.6 - uy * 1.5) * s, (ty - uy * 2.6 + ux * 1.5) * s);
    ctx.lineTo((tx - ux * 2.6 + uy * 1.5) * s, (ty - uy * 2.6 - ux * 1.5) * s);
    ctx.closePath();
    ctx.fill();
    if (opts.handle) {
      ctx.beginPath();
      ctx.arc(tx * s, ty * s, 2.1 * s, 0, Math.PI * 2);
      ctx.fillStyle = opts.handleActive ? "rgba(37,99,235,0.22)" : "rgba(27,29,32,0.08)";
      ctx.fill();
      ctx.strokeStyle = opts.handleActive ? "#2563eb" : "rgba(27,29,32,0.45)";
      ctx.lineWidth = 0.35 * s;
      ctx.stroke();
    }
    ctx.restore();
    return [tx, ty];
  }

  function drawRangeBox(ctx, s) {
    ctx.save();
    ctx.setLineDash([1.2 * s, 1.2 * s]);
    ctx.strokeStyle = "rgba(37,99,235,0.28)";
    ctx.lineWidth = 0.3 * s;
    ctx.strokeRect(CFG.centerMin * s, CFG.centerMin * s, (CFG.centerMax - CFG.centerMin) * s, (CFG.centerMax - CFG.centerMin) * s);
    ctx.restore();
  }

  function drawContactMark(ctx, s, [x, y]) {
    ctx.save();
    ctx.strokeStyle = "#1b1d20";
    ctx.lineWidth = 0.55 * s;
    ctx.beginPath();
    ctx.arc(x * s, y * s, (CFG.ballRadius + 1.6) * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /*
   * ---- 64x64 frames exactly as the models see them ----
   * The trained models' data uses render_frame() at render_scale=1: Pillow draws
   * straight at 64x64 with no antialiasing (the LANCZOS resize to the same size
   * is a no-op). Python's round() is half-to-even, so round(x-4) and round(x+4)
   * always round the same way: the ball is always this 9x9 mask and the square
   * always 11x11. web/selfcheck.html compares the result with the generator's
   * own frames pixel by pixel.
   */
  const BALL_MASK = [
    "...ooo...",
    ".ooFFFoo.",
    ".oFFFFFo.",
    "oFFFFFFFo",
    "oFFFFFFFo",
    "oFFFFFFFo",
    ".oFFFFFo.",
    ".ooFFFoo.",
    "...ooo...",
  ];
  const RGB = {
    white: [255, 255, 255], grid: [224, 224, 224], border: [155, 155, 155],
    obstacleFill: [57, 111, 211], obstacleLine: [31, 73, 154], ballFill: [219, 55, 63], ballLine: [151, 26, 32],
  };

  function pyRound(x) {
    const floor = Math.floor(x);
    const frac = x - floor;
    if (frac === 0.5) return floor % 2 === 0 ? floor : floor + 1;
    return Math.round(x);
  }

  function modelFrame(ball, obstacle) {
    const W = CFG.width, H = CFG.height;
    const img = new ImageData(W, H);
    const px = img.data;
    const put = (x, y, c) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 4;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, RGB.white);
    const m = CFG.borderMargin;
    const far = CFG.width - CFG.borderMargin - 1;
    for (let u = m; u <= far; u += CFG.gridSize) {
      for (let v = m; v <= far; v++) { put(u, v, RGB.grid); put(v, u, RGB.grid); }
    }
    for (let off = 0; off < CFG.borderWidth; off++) {
      for (let v = m + off; v <= far - off; v++) {
        put(v, m + off, RGB.border); put(v, far - off, RGB.border);
        put(m + off, v, RGB.border); put(far - off, v, RGB.border);
      }
    }
    if (obstacle) {
      const half = CFG.obstacleSide / 2;
      const x0 = pyRound(obstacle[0] - half), x1 = pyRound(obstacle[0] + half);
      const y0 = pyRound(obstacle[1] - half), y1 = pyRound(obstacle[1] + half);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          put(x, y, x === x0 || x === x1 || y === y0 || y === y1 ? RGB.obstacleLine : RGB.obstacleFill);
        }
      }
    }
    if (ball) {
      const x0 = pyRound(ball[0] - CFG.ballRadius), y0 = pyRound(ball[1] - CFG.ballRadius);
      BALL_MASK.forEach((row, dy) => {
        for (let dx = 0; dx < row.length; dx++) {
          if (row[dx] === "F") put(x0 + dx, y0 + dy, RGB.ballFill);
          else if (row[dx] === "o") put(x0 + dx, y0 + dy, RGB.ballLine);
        }
      });
    }
    return img;
  }

  /* Per-pixel mean of several frames (one time block). */
  function averageFrames(frames) {
    const out = new ImageData(CFG.width, CFG.height);
    for (let i = 0; i < out.data.length; i++) {
      let sum = 0;
      for (const f of frames) sum += f.data[i];
      out.data[i] = sum / frames.length;
    }
    return out;
  }

  /* |a - b| per pixel, amplified, drawn pixel-exact onto ``canvas``. */
  function drawFrameDiff(canvas, prev, cur, gain = 3) {
    const out = new ImageData(CFG.width, CFG.height);
    for (let i = 0; i < out.data.length; i += 4) {
      let v = 0;
      if (prev && cur) {
        v = (Math.abs(cur.data[i] - prev.data[i]) + Math.abs(cur.data[i + 1] - prev.data[i + 1]) +
             Math.abs(cur.data[i + 2] - prev.data[i + 2])) / 3;
      }
      v = Math.min(255, v * gain);
      out.data[i] = v; out.data[i + 1] = v; out.data[i + 2] = v; out.data[i + 3] = 255;
    }
    const tmp = document.createElement("canvas");
    tmp.width = tmp.height = CFG.width;
    tmp.getContext("2d").putImageData(out, 0, 0);
    const { ctx } = setupCanvas(canvas);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  }

  window.WM.render = {
    setupCanvas, drawWorld, drawBall, drawObstacle, drawPath, drawGhost, drawArrow,
    drawRangeBox, drawContactMark, modelFrame, averageFrames, drawFrameDiff,
  };
})();
