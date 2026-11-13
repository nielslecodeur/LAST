import { useEffect, useRef } from "react";

/**
 * Decorative blue-flame backdrop (WebGL fragment shader, paper palette).
 *
 * `level` in [0, 1] is the flame height: the hero passes the share of the round time left, so the
 * fire visibly burns down and jumps back up when an eligible buy resets the timer. Purely visual:
 * it never decides anything, and it degrades to a flat paper background when WebGL is missing.
 * With `prefers-reduced-motion` it draws one still frame per level change instead of animating.
 */
export function FlameCanvas({ level, className }: { level: number; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const target = useRef(level);
  target.current = Math.min(1, Math.max(0, level));
  const redraw = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!canvas || !gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(program, "R");
    const uTime = gl.getUniformLocation(program, "T");
    const uLevel = gl.getUniformLocation(program, "H");

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let shown = target.current;
    let raf = 0;
    const t0 = performance.now();

    const draw = (time: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1) * 0.6; // soft, cheap: the fire is blurry anyway
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uLevel, 0.06 + 0.84 * shown);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const frame = () => {
      shown += (target.current - shown) * 0.06;
      if (!document.hidden) draw((performance.now() - t0) / 1000);
      raf = requestAnimationFrame(frame);
    };

    if (reduced) {
      redraw.current = () => {
        shown = target.current;
        draw(4.2);
      };
      redraw.current();
    } else {
      raf = requestAnimationFrame(frame);
    }
    return () => {
      cancelAnimationFrame(raf);
      redraw.current = null;
    };
  }, []);

  useEffect(() => {
    redraw.current?.();
  }, [level]);

  return <canvas ref={canvasRef} aria-hidden className={className} />;
}

const VERTEX = "attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}";

// fbm fire: paper -> sky -> NEAR blue -> night blue, with an ink rim and paper grain.
const FRAGMENT = `precision mediump float;
uniform vec2 R;uniform float T,H;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}
float fb(vec2 p){float v=0.,a=.5;for(int i=0;i<6;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
 vec2 uv=gl_FragCoord.xy/R;vec2 q=uv;q.x*=R.x/R.y;
 float w=fb(vec2(q.x*2.2,q.y*2.4-T*1.3));
 float w2=fb(vec2(q.x*5.,q.y*5.-T*2.6)+w);
 float fl=clamp((H-uv.y)*2.6+w2*1.1-.45,0.,1.);
 vec3 paper=vec3(.914,.882,.804),sky=vec3(.514,.863,1.),bl=vec3(0.,.373,.69),dp=vec3(.03,.16,.32),ink=vec3(.196,.18,.145);
 vec3 c=paper;
 c=mix(c,sky,smoothstep(.02,.3,fl));
 c=mix(c,bl,smoothstep(.3,.62,fl));
 c=mix(c,dp,smoothstep(.62,.9,fl));
 float rim=smoothstep(0.,.05,fl)-smoothstep(.05,.12,fl);
 c=mix(c,ink,rim*.35);
 c+=(h(gl_FragCoord.xy+fract(T)*100.)-.5)*.06;
 gl_FragColor=vec4(c,1.);
}`;
