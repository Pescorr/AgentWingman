// The built-in pilot, drawn in SVG. Its eyes and arms are animated by style.css per state;
// whole-body motion and signs come from the shared .motion / .fx layers, like an image skin.
window.PILOT_SVG = `
<svg class="pilot-svg" viewBox="0 0 120 140" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
  <ellipse class="shadow" cx="60" cy="134" rx="30" ry="5"/>
  <g class="bob">
    <g transform="translate(23 83)"><g class="arm arm-l"><rect x="-7" y="-3" width="14" height="26" rx="7"/></g></g>
    <g transform="translate(97 83)"><g class="arm arm-r"><rect x="-7" y="-3" width="14" height="26" rx="7"/></g></g>
    <rect class="suit" x="28" y="66" width="64" height="58" rx="24"/>
    <path class="badge" d="M50 96 L60 88 L70 96 L70 102 L60 94 L50 102 Z"/>
    <line class="antenna" x1="60" y1="22" x2="60" y2="9"/>
    <circle class="lamp-dot" cx="60" cy="7" r="4.5"/>
    <circle class="helmet" cx="60" cy="52" r="34"/>
    <path class="stripe" d="M38 26 Q60 14 82 26 L78 32 Q60 22 42 32 Z"/>
    <rect class="visor" x="33" y="40" width="54" height="28" rx="14"/>
    <g class="eyes">
      <ellipse class="eye" cx="49" cy="54" rx="4.2" ry="5.5"/>
      <ellipse class="eye" cx="71" cy="54" rx="4.2" ry="5.5"/>
    </g>
    <path class="glare" d="M40 46 Q44 42 52 42"/>
  </g>
  <g class="keys"><rect x="34" y="120" width="52" height="8" rx="2"/></g>
</svg>`;
