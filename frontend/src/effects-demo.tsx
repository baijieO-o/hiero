import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import RadialCursor from './effects-cursor';

type Group = { id: string; title: string; items: string[]; render: () => ReactNode };

// Magnetic / tilt helpers read pointer position relative to the element.
function useTilt() {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(600px) rotateX(${-y * 10}deg) rotateY(${x * 10}deg)`;
  };
  const onLeave = () => {
    if (ref.current) ref.current.style.transform = '';
  };
  return { ref, onMove, onLeave };
}

function MagneticButton({ label }: { label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const onMove = (e: MouseEvent<HTMLButtonElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) * 0.25;
    const dy = (e.clientY - (r.top + r.height / 2)) * 0.25;
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const onLeave = () => {
    if (ref.current) ref.current.style.transform = '';
  };
  return (
    <button ref={ref} className="fx-magnetic" onMouseMove={onMove} onMouseLeave={onLeave}>
      {label}
    </button>
  );
}

function Dropdown() {
  const [open, setOpen] = useState(false);
  return (
    <div className="fx-dropdown" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="fx-chip">菜单 ▾</button>
      <div className={`fx-dropdown-panel ${open ? 'is-open' : ''}`}>
        <span>查看详情</span>
        <span>加入购物袋</span>
        <span>分享</span>
      </div>
    </div>
  );
}

function FollowCursor() {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--fx-x', `${e.clientX - r.left}px`);
    el.style.setProperty('--fx-y', `${e.clientY - r.top}px`);
  };
  return (
    <div ref={ref} className="fx-follow" onMouseMove={onMove}>
      <span>鼠标经过这里</span>
    </div>
  );
}

function PointerCard({ title, text }: { title: string; text: string }) {
  const tilt = useTilt();
  return (
    <div ref={tilt.ref} className="fx-card" onMouseMove={tilt.onMove} onMouseLeave={tilt.onLeave}>
      <strong>{title}</strong>
      <p>{text}</p>
      <div className="fx-card-reveal">悬停显现的详情</div>
    </div>
  );
}

function Tooltip() {
  return (
    <span className="fx-tooltip-wrap">
      <button className="fx-chip">悬停我</button>
      <span className="fx-bubble">这里是提示气泡</span>
    </span>
  );
}

function Spotlight() {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--fx-sx', `${e.clientX - r.left}px`);
    el.style.setProperty('--fx-sy', `${e.clientY - r.top}px`);
  };
  return (
    <div ref={ref} className="fx-spotlight" onMouseMove={onMove}>
      <span>版本 A / 版本 B</span>
    </div>
  );
}

function Carousel() {
  const slides = ['第一张', '第二张', '第三张'];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setI((n) => (n + 1) % slides.length), 2500);
    return () => window.clearInterval(t);
  }, [slides.length]);
  return (
    <div className="fx-carousel">
      <div className="fx-slide">{slides[i]}</div>
      <div className="fx-dots">
        {slides.map((s, n) => (
          <button key={s} className={n === i ? 'is-on' : ''} onClick={() => setI(n)} aria-label={s} />
        ))}
      </div>
    </div>
  );
}

function Tabs() {
  const tabs = ['概览', '参数', '日志'];
  const [t, setT] = useState(0);
  return (
    <div className="fx-tabs">
      <div className="fx-tab-row">
        {tabs.map((label, n) => (
          <button key={label} className={n === t ? 'is-on' : ''} onClick={() => setT(n)}>
            {label}
          </button>
        ))}
      </div>
      <div className="fx-tab-body">{tabs[t]} 的内容</div>
    </div>
  );
}

function MorphIcon() {
  const [on, setOn] = useState(false);
  return (
    <button className={`fx-morph ${on ? 'is-on' : ''}`} onClick={() => setOn((v) => !v)} aria-label="切换图标">
      <span />
    </button>
  );
}

function CartBag() {
  const [count, setCount] = useState(0);
  const [toast, setToast] = useState(false);
  const [bump, setBump] = useState(false);
  const add = () => {
    setCount((n) => n + 1);
    setBump(true);
    setToast(true);
    window.setTimeout(() => setBump(false), 300);
    window.setTimeout(() => setToast(false), 1400);
  };
  return (
    <div className="fx-cart">
      <button className="fx-chip fx-ripple" onClick={add}>
        加入购物袋
      </button>
      <span className={`fx-count ${bump ? 'is-bump' : ''}`}>{count}</span>
      <div className={`fx-toast ${toast ? 'is-on' : ''}`}>已加入</div>
    </div>
  );
}

function Drawer() {
  const [open, setOpen] = useState(false);
  return (
    <div className="fx-drawer-wrap">
      <button className="fx-chip" onClick={() => setOpen((v) => !v)}>
        {open ? '收起抽屉' : '打开抽屉'}
      </button>
      <div className={`fx-drawer ${open ? 'is-open' : ''}`}>抽屉内容</div>
    </div>
  );
}

function LayoutTransition() {
  const [wide, setWide] = useState(false);
  return (
    <div className={`fx-layout ${wide ? 'is-wide' : ''}`}>
      <button className="fx-chip" onClick={() => setWide((v) => !v)}>
        切换布局
      </button>
      <div className="fx-layout-box">布局过渡</div>
    </div>
  );
}

function Accordion() {
  const [open, setOpen] = useState(true);
  return (
    <div className="fx-accordion">
      <button className="fx-chip" onClick={() => setOpen((v) => !v)}>
        {open ? '折叠' : '展开'}
      </button>
      <div className={`fx-accordion-body ${open ? 'is-open' : ''}`}>
        <div>页尾的折叠内容</div>
      </div>
    </div>
  );
}

function Skeleton() {
  const [loading, setLoading] = useState(true);
  return (
    <div className="fx-skeleton-wrap">
      <button className="fx-chip" onClick={() => setLoading((v) => !v)}>
        {loading ? '显示内容' : '显示骨架屏'}
      </button>
      {loading ? (
        <div className="fx-skeleton">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <div className="fx-skeleton-content">加载完成</div>
      )}
    </div>
  );
}

function Feedback() {
  const [err, setErr] = useState(false);
  return (
    <div className="fx-feedback">
      <button className="fx-chip" onClick={() => setErr(true)}>
        触发错误
      </button>
      {err && (
        <div className="fx-error" onAnimationEnd={() => setErr(false)}>
          出错了，请重试
        </div>
      )}
    </div>
  );
}

function Modal() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button className="fx-chip" onClick={() => setOpen(true)}>
        打开弹窗
      </button>
      {open && (
        <div className="fx-modal-mask" onClick={() => setOpen(false)}>
          <div className="fx-modal" onClick={(e) => e.stopPropagation()}>
            <p>这是一个弹窗</p>
            <button className="fx-chip" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PageTransition() {
  const [flip, setFlip] = useState(false);
  return (
    <div className="fx-page">
      <button className="fx-chip" onClick={() => setFlip((v) => !v)}>
        切换页面
      </button>
      <div key={String(flip)} className="fx-page-view">
        {flip ? '第二页' : '第一页'}
      </div>
    </div>
  );
}

function AnimatedNumber() {
  const [n, setN] = useState(0);
  return (
    <div className="fx-number">
      <button className="fx-chip" onClick={() => setN((v) => v + 7)}>
        +7
      </button>
      <span key={n} className="fx-roll">
        {n}
      </span>
    </div>
  );
}

const groups: Group[] = [
  {
    id: 'hover',
    title: '01 鼠标一碰',
    items: ['悬停', '下拉菜单', '磁吸按钮', '跟随鼠标转动'],
    render: () => (
      <div className="fx-row">
        <button className="fx-chip">悬停变色</button>
        <Dropdown />
        <MagneticButton label="磁吸按钮" />
        <PointerCard title="跟随鼠标转动" text="鼠标移动时卡片轻微倾斜" />
      </div>
    ),
  },
  {
    id: 'cursor',
    title: '02 指针',
    items: ['自定义光标', '指针响应背景', '光标拖尾'],
    render: () => <FollowCursor />,
  },
  {
    id: 'card',
    title: '03 卖点卡片',
    items: ['倾斜卡片', '悬停显现', '提示气泡'],
    render: () => (
      <div className="fx-row">
        <PointerCard title="倾斜卡片" text="鼠标移到卡片上" />
        <Tooltip />
      </div>
    ),
  },
  {
    id: 'spotlight',
    title: '04 挑版本',
    items: ['光标聚光灯', '共享元素转场'],
    render: () => <Spotlight />,
  },
  {
    id: 'detail',
    title: '05 看详情',
    items: ['轮播', '标签切换', '图标形变'],
    render: () => (
      <div className="fx-row fx-row-top">
        <Carousel />
        <Tabs />
        <MorphIcon />
      </div>
    ),
  },
  {
    id: 'cart',
    title: '06 加购物袋',
    items: ['点击涟漪', '成功反馈', '数字滚动', '轻提示', '抽屉', '布局过渡'],
    render: () => (
      <div className="fx-row fx-row-top">
        <CartBag />
        <AnimatedNumber />
        <Drawer />
        <LayoutTransition />
      </div>
    ),
  },
  {
    id: 'footer',
    title: '07 页尾和结账',
    items: ['折叠展开', '骨架屏', '弹窗', '错误反馈', '页面转场'],
    render: () => (
      <div className="fx-row fx-row-top">
        <Accordion />
        <Skeleton />
        <Modal />
        <Feedback />
        <PageTransition />
      </div>
    ),
  },
];

export default function EffectsDemo() {
  const [active, setActive] = useState('hover');
  const current = groups.find((g) => g.id === active) ?? groups[0];
  return (
    <div className="fx-page-root">
      <RadialCursor />
      <header className="fx-header">
        <h1>交互效果库</h1>
        <nav className="fx-nav">
          {groups.map((g) => (
            <button key={g.id} className={`fx-nav-item ${g.id === active ? 'is-on' : ''}`} onClick={() => setActive(g.id)}>
              <span className="fx-nav-title">{g.title}</span>
              <span className="fx-nav-items">
                {g.items.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </span>
            </button>
          ))}
        </nav>
      </header>
      <main className="fx-stage" style={{ '--fx-accent': '#ff8a3d' } as CSSProperties}>
        <h2>{current.title}</h2>
        {current.render()}
      </main>
    </div>
  );
}
