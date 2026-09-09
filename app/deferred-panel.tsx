import { Component, lazy, Suspense, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';

class PanelBoundary extends Component<{ name: string; retry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className='notice' role='alert'><div><p>{this.props.name} could not open. Check your connection and try again.</p><button type='button' className='secondary-button' onClick={this.props.retry}>Retry {this.props.name.toLocaleLowerCase()}</button></div></div>;
    return this.props.children;
  }
}

/** Keep the surrounding conversation and dialog mounted while optional panels load. */
export function deferredPanel<T extends ComponentType<any>>(name: string, load: () => Promise<{ default: T }>): ComponentType<ComponentProps<T>> {
  return function DeferredPanel(props: ComponentProps<T>) {
    const [state, setState] = useState(() => ({ attempt: 0, Panel: lazy(load) }));
    const retry = () => setState(previous => ({ attempt: previous.attempt + 1, Panel: lazy(load) }));
    const Panel = state.Panel as ComponentType<ComponentProps<T>>;
    return <PanelBoundary key={state.attempt} name={name} retry={retry}><Suspense fallback={<p role='status' aria-live='polite'>Loading {name.toLocaleLowerCase()}…</p>}><Panel {...props}/></Suspense></PanelBoundary>;
  };
}
