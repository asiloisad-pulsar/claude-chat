/** @babel */

import React, { useRef, useEffect } from "react";
import HighlightedContent from "./highlighted-content";

/**
 * React wrapper around the HighlightedContent class component.
 * HighlightedContent manages its own DOM element directly (async tree-sitter
 * syntax highlighting), so we mount/unmount it via useEffect.
 */
export function HighlightedContentWrapper({ html }) {
  const containerRef = useRef(null);
  const instanceRef = useRef(null);

  useEffect(() => {
    const inst = new HighlightedContent({ html });
    instanceRef.current = inst;
    containerRef.current.appendChild(inst.element);
    return () => {
      inst.destroy();
      inst.element.remove();
      instanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    instanceRef.current?.update({ html });
  }, [html]);

  return <div ref={containerRef} />;
}
