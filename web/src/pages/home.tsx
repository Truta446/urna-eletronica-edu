import { Link } from '../lib/router';

export function HomePage() {
  return (
    <>
      <h1>Uma eleição inteira, papel por papel</h1>
      <p className="lede">
        Protótipo de estudo de uma urna eletrônica: o eleitor vota uma vez, ninguém liga o voto à
        pessoa, e qualquer um confere o resultado. Abra cada papel numa aba diferente e siga a ordem
        abaixo.
      </p>
      <ol className="roles">
        <li>
          <span className="roles__step">1</span>
          <div>
            <Link href="/administracao">Administração</Link>
            <p className="muted">
              Cria a eleição, cadastra candidatos e eleitores, abre e encerra a votação e faz a
              apuração. Numa eleição cifrada, a cerimônia de chaves acontece aqui, no seu navegador.
            </p>
          </div>
        </li>
        <li>
          <span className="roles__step">2</span>
          <div>
            <Link href="/mesario">Mesário</Link>
            <p className="muted">
              Confere o CPF do eleitor e libera a urna. O mesário sabe quem vai votar, mas nunca vê
              o voto.
            </p>
          </div>
        </li>
        <li>
          <span className="roles__step">3</span>
          <div>
            <Link href="/urna">Urna</Link>
            <p className="muted">
              Fica bloqueada até o mesário liberar. Deixe-a aberta em outra aba ou janela, ao lado
              do mesário.
            </p>
          </div>
        </li>
        <li>
          <span className="roles__step">4</span>
          <div>
            <Link href="/resultados">Resultados</Link>
            <p className="muted">
              Boletim de urna público depois da apuração, com verificação independente feita pelo
              seu navegador.
            </p>
          </div>
        </li>
      </ol>
    </>
  );
}
