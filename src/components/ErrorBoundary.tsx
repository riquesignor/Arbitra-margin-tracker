import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import styles from "./ErrorBoundary.module.css";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Único jeito de capturar erro de render em React sem lib externa é via
// class component (getDerivedStateFromError/componentDidCatch não têm
// equivalente em hooks). Fica na raiz do app (ver main.tsx) — sem isso,
// qualquer erro não tratado em qualquer tela derruba o app inteiro pra
// tela branca, sem chance de recuperação sem reload manual.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] erro não tratado:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className={styles.wrapper}>
          <div className={styles.card}>
            <AlertTriangle size={28} className={styles.icon} />
            <h1 className={styles.title}>Algo deu errado</h1>
            <p className={styles.message}>
              Ocorreu um erro inesperado nesta tela. Você pode tentar recarregar
              a página — seus dados salvos não são afetados.
            </p>
            <button
              type="button"
              className={styles.button}
              onClick={() => window.location.reload()}
            >
              Recarregar página
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
