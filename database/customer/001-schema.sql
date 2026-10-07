--
-- PostgreSQL database dump
--

\restrict 1gF6D5XBqHWfApbCokg7rHg7nAftdxdJvIEyf7LxxMTL5MkkAVtYHOGRKF7cBIA

-- Dumped from database version 17.11 (Debian 17.11-1.pgdg13+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    uid integer NOT NULL,
    fullname character varying(100) NOT NULL,
    mid integer NOT NULL,
    CONSTRAINT customers_uid_check CHECK ((uid > 0))
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    mid integer NOT NULL,
    mname character varying(50) NOT NULL,
    score integer NOT NULL,
    CONSTRAINT memberships_score_check CHECK ((score >= 0))
);


--
-- Name: memberships_mid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memberships_mid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memberships_mid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memberships_mid_seq OWNED BY public.memberships.mid;


--
-- Name: memberships mid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships ALTER COLUMN mid SET DEFAULT nextval('public.memberships_mid_seq'::regclass);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (uid);


--
-- Name: memberships memberships_mname_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_mname_key UNIQUE (mname);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (mid);


--
-- Name: customers customers_mid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_mid_fkey FOREIGN KEY (mid) REFERENCES public.memberships(mid);


--
-- PostgreSQL database dump complete
--

\unrestrict 1gF6D5XBqHWfApbCokg7rHg7nAftdxdJvIEyf7LxxMTL5MkkAVtYHOGRKF7cBIA

