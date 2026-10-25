import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./TooltipLayer.module.css";

/**
 * Tooltip do app inteiro (out/2026) — em vez de trocar os ~65 `title=`
 * espalhados pelas telas um por um, esta camada única (montada em
 * main.tsx) intercepta qualquer elemento com `title`: na hora de mostrar,
 * guarda o texto, tira o `title` (some o tooltip nativo, que é lento, sem
 * estilo e não aparece no foco do teclado) e desenha o nosso; ao sair,
 * devolve o `title` original. Componente novo pode continuar usando
 * `title` normalmente.
 *
 * Mostra no hover (mouse/caneta, não toque — o nativo também não aparecia
 * no toque) e no foco por teclado; some no clique, no Esc e na rolagem.
 */

const SHOW_DELAY_MS = 400;
/** Logo depois de um tooltip sumir, o próximo aparece sem espera (passar o mouse por uma linha de ícones). */
const WARM_WINDOW_MS = 400;
const GAP_PX = 8;
const EDGE_PX = 8;
const TOOLTIP_ID = "app-tooltip";

interface Active {
  target: Element;
  text: string;
}

function findTitled(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest("[title], [data-app-tooltip]");
  if (!el || el.closest("svg") || el.tagName === "IFRAME") return null;
  const text = el.getAttribute("title") ?? el.getAttribute("data-app-tooltip");
  return text && text.trim() ? el : null;
}

export default function TooltipLayer() {
  const [active, setActive] = useState<Active | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: "top" | "bottom" } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<Active | null>(null);
  const showTimer = useRef<number | null>(null);
  const lastHiddenAt = useRef(0);

  useEffect(() => {
    function restore(a: Active) {
      if (!a.target.hasAttribute("title")) a.target.setAttribute("title", a.text);
      a.target.removeAttribute("data-app-tooltip");
      const described = (a.target.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .filter((id) => id && id !== TOOLTIP_ID);
      if (described.length) a.target.setAttribute("aria-describedby", described.join(" "));
      else a.target.removeAttribute("aria-describedby");
    }

    function hide() {
      if (showTimer.current) window.clearTimeout(showTimer.current);
      showTimer.current = null;
      const current = activeRef.current;
      if (!current) return;
      restore(current);
      activeRef.current = null;
      lastHiddenAt.current = Date.now();
      setActive(null);
      setPos(null);
    }

    function show(el: Element) {
      const text = el.getAttribute("title") ?? el.getAttribute("data-app-tooltip") ?? "";
      if (activeRef.current?.target === el) return;
      hide();
      // Guarda o texto fora do `title` enquanto o nosso estiver na tela (senão o nativo aparece por cima).
      el.setAttribute("data-app-tooltip", text);
      el.removeAttribute("title");
      const described = el.getAttribute("aria-describedby");
      el.setAttribute("aria-describedby", described ? `${described} ${TOOLTIP_ID}` : TOOLTIP_ID);
      const next = { target: el, text };
      activeRef.current = next;
      setActive(next);
    }

    function schedule(el: Element, immediate: boolean) {
      if (showTimer.current) window.clearTimeout(showTimer.current);
      const warm = Date.now() - lastHiddenAt.current < WARM_WINDOW_MS;
      if (immediate || warm || activeRef.current) {
        show(el);
        return;
      }
      showTimer.current = window.setTimeout(() => show(el), SHOW_DELAY_MS);
    }

    function onPointerOver(e: PointerEvent) {
      if (e.pointerType === "touch") return;
      const el = findTitled(e.target);
      if (!el) return;
      schedule(el, false);
    }

    function onPointerOut(e: PointerEvent) {
      const el = findTitled(e.target);
      if (!el) return;
      const to = e.relatedTarget;
      if (to instanceof Node && el.contains(to)) return;
      hide();
    }

    function onFocusIn(e: FocusEvent) {
      const target = e.target;
      // Só foco de teclado — clique com mouse também foca botões e não deve abrir tooltip.
      if (!(target instanceof Element) || !target.matches(":focus-visible")) return;
      const el = findTitled(target);
      if (el) schedule(el, true);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") hide();
    }

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  // Se o componente React re-renderizar o elemento com um `title` novo
  // enquanto o tooltip está aberto, adota o texto novo e some com o nativo de novo.
  useEffect(() => {
    if (!active) return;
    const observer = new MutationObserver(() => {
      // O próprio `hide()` devolve o `title` — se este tooltip já foi
      // fechado, essa mudança é nossa, não um título novo do React.
      if (activeRef.current?.target !== active.target) return;
      const fresh = active.target.getAttribute("title");
      if (fresh == null) return;
      active.target.removeAttribute("title");
      active.target.setAttribute("data-app-tooltip", fresh);
      const next = { target: active.target, text: fresh };
      activeRef.current = next;
      setActive(next);
    });
    observer.observe(active.target, { attributes: true, attributeFilter: ["title"] });
    // Elemento removido da página (ex.: a linha foi apagada) — some o tooltip.
    const alive = window.setInterval(() => {
      if (!active.target.isConnected) {
        activeRef.current = null;
        setActive(null);
        setPos(null);
      }
    }, 300);
    return () => {
      observer.disconnect();
      window.clearInterval(alive);
    };
  }, [active]);

  useLayoutEffect(() => {
    if (!active || !tipRef.current) return;
    const anchor = active.target.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    const fitsAbove = anchor.top - tip.height - GAP_PX >= EDGE_PX;
    const placement = fitsAbove ? "top" : "bottom";
    const top = fitsAbove ? anchor.top - tip.height - GAP_PX : anchor.bottom + GAP_PX;
    const centered = anchor.left + anchor.width / 2 - tip.width / 2;
    const left = Math.min(Math.max(centered, EDGE_PX), window.innerWidth - tip.width - EDGE_PX);
    setPos({ top, left, placement });
  }, [active]);

  if (!active) return null;
  return createPortal(
    <div
      ref={tipRef}
      id={TOOLTIP_ID}
      role="tooltip"
      className={styles.tooltip}
      data-placement={pos?.placement}
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999, visibility: "hidden" }}
    >
      {active.text}
    </div>,
    document.body
  );
}
