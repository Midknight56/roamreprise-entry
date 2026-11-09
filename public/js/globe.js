// Longitude ray casting also handles polygon holes and MultiPolygons.
export function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i],
      [u, v] = ring[j];
    if (y > lat !== v > lat && lon < ((u - x) * (lat - y)) / (v - y) + x)
      inside = !inside;
  }
  return inside;
}
// A point inside a polygon hole is water, even when the outer ring contains it.
export function onLand(lon, lat, polygons) {
  return polygons.some(
    (p) =>
      inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h)),
  );
}
const idleCleanup = new WeakMap();
export function stopIdleGlobe(container) {
  idleCleanup.get(container)?.();
  idleCleanup.delete(container);
}
// Draw a lightweight dotted globe immediately so the first screen has a destination.
export async function showIdleGlobe(container) {
  let frame, observer, stopped = false, canvas;
  const cleanup = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    canvas?.remove();
    container.classList.remove('globe-idle');
  };
  idleCleanup.set(container, cleanup);
  try {
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2')) return;
    container.classList.add('globe-idle');
    const response = await fetch('/data/ne_110m_land.geojson');
    if (!response.ok) { container.classList.remove('globe-idle'); return; }
    const land = await response.json();
    if (stopped) return;
    const polygons = land.features.flatMap((f) => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
    const samples = [];
    for (let lat = -60; lat < 85; lat += 2)
      for (let lon = -180; lon < 180; lon += 2)
        if (onLand(lon, lat, polygons)) samples.push([lat, lon]);
    canvas = document.createElement('canvas');
    canvas.className = 'idle-globe';
    canvas.setAttribute('aria-hidden', 'true');
    container.append(canvas);
    function draw(now = 0) {
      const w = container.clientWidth, h = container.clientHeight, ratio = Math.min(devicePixelRatio || 1, 2);
      canvas.width = w * ratio; canvas.height = h * ratio;
      const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, w, h);
      const radius = Math.min(w, h) * .43, cx = w / 2, cy = h / 2;
      const turn = now * .000035;
      const gradient = ctx.createRadialGradient(cx - radius * .3, cy - radius * .35, 2, cx, cy, radius);
      gradient.addColorStop(0, '#153957'); gradient.addColorStop(1, '#0e1b2c');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
      for (const [lat, lon] of samples) {
        const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180 + turn;
        const z = Math.cos(phi) * Math.cos(lambda);
        if (z <= 0) continue;
        ctx.fillStyle = `rgba(123,185,219,${.35 + z * .5})`;
        ctx.beginPath(); ctx.arc(cx + radius * Math.cos(phi) * Math.sin(lambda), cy - radius * Math.sin(phi), 1.15, 0, Math.PI * 2); ctx.fill();
      }
      const phi = 38.72 * Math.PI / 180, lambda = -9.14 * Math.PI / 180 + turn;
      if (Math.cos(phi) * Math.cos(lambda) > 0) {
        const x = cx + radius * Math.cos(phi) * Math.sin(lambda), y = cy - radius * Math.sin(phi);
        ctx.fillStyle = '#E8B04B'; ctx.shadowColor = '#E8B04B'; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      }
      if (!stopped && !matchMedia('(prefers-reduced-motion: reduce)').matches) frame = requestAnimationFrame(draw);
    }
    draw(); observer = new ResizeObserver(() => draw()); observer.observe(container);
  } catch { stopIdleGlobe(container); /* Keep the route map as the fallback. */ }
}
// Keep the usable route map underneath the temporary WebGL transition.
export async function flyToLisbon(container, trip) {
  let renderer, frame, observer;
  function dispose() {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    if (renderer) {
      renderer.domElement.remove();
      renderer.dispose();
    }
    container.classList.remove('globe-active');
  }
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Avoid asking three.js to construct a context on devices without WebGL.
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2')) return;
    const THREE = await import('three');
    const response = await fetch('/data/ne_110m_land.geojson');
    if (!response.ok) return;
    const land = await response.json();
    const polygons = land.features.flatMap((f) =>
      f.geometry.type === 'Polygon'
        ? [f.geometry.coordinates]
        : f.geometry.type === 'MultiPolygon'
          ? f.geometry.coordinates
          : [],
    );
    const bounds = polygons.map((p) => ({
      p,
      minX: Math.min(...p[0].map((c) => c[0])),
      maxX: Math.max(...p[0].map((c) => c[0])),
      minY: Math.min(...p[0].map((c) => c[1])),
      maxY: Math.max(...p[0].map((c) => c[1])),
    }));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    container.append(renderer.domElement);
    container.classList.add('globe-active');
    idleCleanup.get(container)?.(); idleCleanup.delete(container);
    const globe = new THREE.Group();
    scene.add(globe);
    // Longitude rotates around the vertical axis; latitude raises each land dot.
    function spherePoint(lat, lon, r = 1) {
      return new THREE.Vector3(
        r * Math.cos((lat * Math.PI) / 180) * Math.sin((lon * Math.PI) / 180),
        r * Math.sin((lat * Math.PI) / 180),
        r * Math.cos((lat * Math.PI) / 180) * Math.cos((lon * Math.PI) / 180),
      );
    }
    const points = [];
    for (let lat = -60; lat < 85; lat += 0.6)
      for (let lon = -180; lon < 180; lon += 0.6) {
        const nearby = bounds.filter(
          (b) =>
            lon >= b.minX && lon <= b.maxX && lat >= b.minY && lat <= b.maxY,
        );
        if (
          onLand(
            lon,
            lat,
            nearby.map((b) => b.p),
          )
        )
          points.push(spherePoint(lat, lon));
      }
    const dots = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.0018, 5, 4),
      new THREE.MeshBasicMaterial({ color: '#7bb9db' }),
      points.length,
    );
    const dummy = new THREE.Object3D();
    points.forEach((p, n) => {
      dummy.position.copy(p);
      dummy.updateMatrix();
      dots.setMatrixAt(n, dummy.matrix);
    });
    globe.add(dots);
    globe.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(0.993, 48, 32),
        new THREE.MeshBasicMaterial({ color: '#102c49' }),
      ),
    );
    const rim = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 48, 32),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {},
        vertexShader: `
          varying vec3 n;
          varying vec3 v;
          void main() {
            vec4 p = modelViewMatrix * vec4(position, 1.0);
            n = normalize(normalMatrix * normal);
            v = normalize(-p.xyz);
            gl_Position = projectionMatrix * p;
          }
        `,
        fragmentShader: `
          varying vec3 n;
          varying vec3 v;
          void main() {
            float a = pow(1.0 - abs(dot(normalize(n), normalize(v))), 3.0) * 0.5;
            gl_FragColor = vec4(0.35, 0.65, 0.9, a);
          }
        `,
      }),
    );
    globe.add(rim);
    const pins = new THREE.Group();
    globe.add(pins);
    const pin = new THREE.Mesh(
      new THREE.SphereGeometry(0.004, 12, 8),
      new THREE.MeshBasicMaterial({ color: '#E8B04B' }),
    );
    pin.position.copy(spherePoint(38.72, -9.14, 1.006));
    pins.add(pin);
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 160; labelCanvas.height = 48;
    const labelContext = labelCanvas.getContext('2d');
    labelContext.font = '26px Arial';
    labelContext.fillStyle = '#fff3d2';
    labelContext.fillText('Lisbon', 8, 33);
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, depthTest: false }));
    label.position.copy(spherePoint(38.72, -9.14, 1.012));
    label.center.set(-0.12, 0.5);
    label.scale.set(0.11, 0.033, 1);
    pins.add(label);
    function resize() {
      const w = container.clientWidth,
        h = container.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(container);
    const start = performance.now();
    await new Promise((resolve) => {
    // Smoothstep eases the Atlantic camera into Lisbon over three seconds.
      function tick(now) {
        const progress = Math.min((now - start) / 3000, 1),
          ease = progress * progress * (3 - 2 * progress);
        camera.position.copy(
          spherePoint(15 + 23.72 * ease, -55 + 45.86 * ease, 3.2 - 1.6 * ease),
        );
        camera.lookAt(spherePoint(38.72, -9.14, 0.32 * ease));
        pins.scale.setScalar(
          Math.max(0.001, Math.min(1, (progress - 0.6) / 0.3)),
        );
        renderer.render(scene, camera);
        if (progress < 1) frame = requestAnimationFrame(tick);
        else resolve();
      }
      frame = requestAnimationFrame(tick);
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    renderer.domElement.classList.add('globe-fade');
    await new Promise((resolve) => setTimeout(resolve, 450));
    labelTexture.dispose();
    scene.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) o.material.dispose();
    });
  } catch {
    /* The route map underneath is the usable fallback. */
  } finally {
    idleCleanup.get(container)?.(); idleCleanup.delete(container);
    dispose();
  }
}
