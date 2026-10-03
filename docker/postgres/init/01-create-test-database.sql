-- Banco isolado para a suíte de testes: os testes truncam tabelas e não podem tocar no banco de dev.
CREATE DATABASE urna_test OWNER urna;

-- Banco isolado para o benchmark (npm run bench): também é truncado a cada execução.
CREATE DATABASE urna_bench OWNER urna;
