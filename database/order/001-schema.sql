--
-- PostgreSQL database dump
--

\restrict cgeEt57QoNYgabLuBrRiKqcu4J07NlpYWjkvc85cYtcfDptjVWsI5pmYz7w9EK6

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
-- Name: inventory_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inventory_tasks (
    reservation_id uuid NOT NULL,
    request_id uuid NOT NULL,
    pid integer NOT NULL,
    qty integer NOT NULL,
    unit_price numeric(10,2),
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    CONSTRAINT inventory_tasks_pid_check CHECK ((pid > 0)),
    CONSTRAINT inventory_tasks_qty_check CHECK ((qty > 0)),
    CONSTRAINT inventory_tasks_status_check CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'RESERVED'::character varying, 'RELEASED'::character varying])::text[])))
);


--
-- Name: order_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_attempts (
    request_id uuid NOT NULL,
    uid integer NOT NULL,
    items jsonb NOT NULL,
    status character varying(20) DEFAULT 'PROCESSING'::character varying NOT NULL,
    oid integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_attempts_status_check CHECK (((status)::text = ANY ((ARRAY['PROCESSING'::character varying, 'COMPLETED'::character varying, 'CANCELLED'::character varying])::text[]))),
    CONSTRAINT order_attempts_uid_check CHECK ((uid > 0))
);


--
-- Name: order_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_details (
    oid integer NOT NULL,
    pid integer NOT NULL,
    qty integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    CONSTRAINT order_details_pid_check CHECK ((pid > 0)),
    CONSTRAINT order_details_qty_check CHECK ((qty > 0)),
    CONSTRAINT order_details_unit_price_check CHECK ((unit_price >= (0)::numeric))
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    oid integer NOT NULL,
    uid integer NOT NULL,
    discount numeric(10,2) DEFAULT 0 NOT NULL,
    total_amount numeric(18,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT orders_discount_check CHECK ((discount >= (0)::numeric)),
    CONSTRAINT orders_total_amount_check CHECK ((total_amount >= (0)::numeric)),
    CONSTRAINT orders_uid_check CHECK ((uid > 0))
);


--
-- Name: orders_oid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.orders_oid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders_oid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.orders_oid_seq OWNED BY public.orders.oid;


--
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    event_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    aggregate_id integer NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone
);


--
-- Name: orders oid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders ALTER COLUMN oid SET DEFAULT nextval('public.orders_oid_seq'::regclass);


--
-- Name: inventory_tasks inventory_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_tasks
    ADD CONSTRAINT inventory_tasks_pkey PRIMARY KEY (reservation_id);


--
-- Name: inventory_tasks inventory_tasks_request_id_pid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_tasks
    ADD CONSTRAINT inventory_tasks_request_id_pid_key UNIQUE (request_id, pid);


--
-- Name: order_attempts order_attempts_oid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_attempts
    ADD CONSTRAINT order_attempts_oid_key UNIQUE (oid);


--
-- Name: order_attempts order_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_attempts
    ADD CONSTRAINT order_attempts_pkey PRIMARY KEY (request_id);


--
-- Name: order_details order_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_details
    ADD CONSTRAINT order_details_pkey PRIMARY KEY (oid, pid);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (oid);


--
-- Name: outbox_events outbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_pkey PRIMARY KEY (event_id);


--
-- Name: idx_orders_uid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_uid ON public.orders USING btree (uid);


--
-- Name: idx_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_pending ON public.outbox_events USING btree (created_at) WHERE (published_at IS NULL);


--
-- Name: inventory_tasks inventory_tasks_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inventory_tasks
    ADD CONSTRAINT inventory_tasks_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.order_attempts(request_id);


--
-- Name: order_attempts order_attempts_oid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_attempts
    ADD CONSTRAINT order_attempts_oid_fkey FOREIGN KEY (oid) REFERENCES public.orders(oid);


--
-- Name: order_details order_details_oid_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_details
    ADD CONSTRAINT order_details_oid_fkey FOREIGN KEY (oid) REFERENCES public.orders(oid) ON DELETE CASCADE;


--
-- Name: outbox_events outbox_events_aggregate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT outbox_events_aggregate_id_fkey FOREIGN KEY (aggregate_id) REFERENCES public.orders(oid);


--
-- PostgreSQL database dump complete
--

\unrestrict cgeEt57QoNYgabLuBrRiKqcu4J07NlpYWjkvc85cYtcfDptjVWsI5pmYz7w9EK6

